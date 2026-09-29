import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// `.dev/stack.yml` is parsed with Bun.YAML, which the vitest worker does not
// have: every case runs the real module under bun.
const WORKFLOW = join(import.meta.dirname, 'workflow.js')
const CI_WATCH = join(import.meta.dirname, '..', 'ci-watch', 'ci-watch.sh')
const EVENT_AT = '2026-09-29T10:00:05Z'
const EVENTS_JQ = '.[] | select(.event == "labeled" and .label.name == "reviewed") | .created_at'

const DRIVER = `
const [mod, fn, cwd, pr, eventsMode] = process.argv.slice(1)
const { landPr, readLanding } = await import(mod)
if (fn === 'readLanding') {
  try {
    console.log(JSON.stringify(readLanding(cwd)))
  } catch (e) {
    console.log(JSON.stringify({ error: e.message }))
  }
  process.exit(0)
}
const calls = []
const gh = async (_cwd, args) => {
  calls.push(args)
  if (args[0] === 'repo') return JSON.stringify({ nameWithOwner: 'acme/app' })
  if (args[0] === 'pr' && args[1] === 'view' && args.includes('baseRefName')) return JSON.stringify({ baseRefName: 'main' })
  if (args[0] === 'pr' && args[1] === 'view' && args.includes('labels')) return JSON.stringify({ labels: [] })
  if (args[0] === 'api' && String(args[1] ?? '').includes('/events')) {
    if (eventsMode === 'fail') throw new Error('HTTP 500')
    if (eventsMode === 'empty') return ''
    return '2026-09-29T09:00:00Z\\n${EVENT_AT}\\n'
  }
  if (args[0] === 'api') throw new Error('HTTP 403')
  return ''
}
console.log(JSON.stringify({ result: await landPr(cwd, Number(pr), { gh }), calls }))
`

/** A checkout with the given files, relative path → content. */
function checkout(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'land-seam-'))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  return dir
}

function land(cwd, eventsMode = 'ok') {
  return JSON.parse(execFileSync('bun', ['-e', DRIVER, WORKFLOW, 'landPr', cwd, '7', eventsMode], { encoding: 'utf8' }))
}

function readLanding(cwd) {
  return JSON.parse(execFileSync('bun', ['-e', DRIVER, WORKFLOW, 'readLanding', cwd], { encoding: 'utf8' }))
}

/** Pull the shell-quoted path out of `bash '<path>' …`. */
function watchScript(watch) {
  const m = /^bash '([^']*(?:'\\''[^']*)*)'/.exec(watch)
  return m ? m[1].replace(/'\\''/g, "'") : ''
}

const WORKFLOW_FILE = { '.github/workflows/merge-on-green.yml': 'name: merge-on-green\n' }
const PROTECTION = ['api', 'repos/acme/app/branches/main/protection/required_status_checks']
const RULES = ['api', 'repos/acme/app/rules/branches/main']
const EVENTS = ['api', 'repos/acme/app/issues/7/events', '--paginate', '--jq', EVENTS_JQ]

describe('landPr through the checkout', () => {
  it('a merge-on-green workflow and a stack with no landing block watch merge-on-green, asking no rules API', () => {
    const { result, calls } = land(checkout({ ...WORKFLOW_FILE, '.dev/stack.yml': 'runtime: bun\n' }))
    expect(result).toMatchObject({ status: 'watching', mode: 'merge-on-green' })
    const script = watchScript(result.watch)
    expect(script.startsWith('/')).toBe(true)
    expect(existsSync(script)).toBe(true)
    expect(result.watch).toBe(`bash '${script}' 7 --merge-mode merge-on-green --since ${EVENT_AT}`)
    // The absolute path is the real ci-watch.sh: a pure hook works from a cwd outside the plugin.
    const outside = mkdtempSync(join(tmpdir(), 'land-watch-cwd-'))
    expect(
      execFileSync('bash', [script, '--classify-checks'], {
        encoding: 'utf8',
        cwd: outside,
        input: '[]',
      }).trim(),
    ).toBe('PENDING')
    // The stub answers repo view, baseRefName and protection/rules api; a probe would show here.
    expect(calls).toEqual([
      ['pr', 'view', '7', '--json', 'labels'],
      ['pr', 'edit', '7', '--add-label', 'reviewed'],
      ['repo', 'view', '--json', 'nameWithOwner'],
      EVENTS,
    ])
  })

  it('events read failing omits --since and still returns watching', () => {
    const { result, calls } = land(checkout({ ...WORKFLOW_FILE, '.dev/stack.yml': 'runtime: bun\n' }), 'fail')
    expect(result).toMatchObject({ status: 'watching', mode: 'merge-on-green' })
    expect(result.watch).not.toContain('--since')
    expect(calls).toEqual([
      ['pr', 'view', '7', '--json', 'labels'],
      ['pr', 'edit', '7', '--add-label', 'reviewed'],
      ['repo', 'view', '--json', 'nameWithOwner'],
      EVENTS,
    ])
  })

  it.each([
    ['flow style', 'landing: { mode: native }\n'],
    ['4-space indent', 'landing:\n    mode: native\n'],
    ['block style', 'landing:\n  mode: native\n'],
  ])('%s landing.mode native beats the workflow file and asks protection and rulesets', (_style, stack) => {
    const { result, calls } = land(checkout({ ...WORKFLOW_FILE, '.dev/stack.yml': stack }))
    expect(result).toEqual({ status: 'no-required-checks' })
    expect(calls).toContainEqual(PROTECTION)
    expect(calls).toContainEqual(RULES)
  })

  it.each([
    ['malformed YAML', 'landing: [unclosed\n', /not valid YAML/],
    ['a landing that is not a map', 'landing: native\n', /landing is not a map/],
    ['an unknown mode', 'landing:\n  mode: auto\n', /landing\.mode must be native or merge-on-green/],
    ['required_checks not a list', 'landing:\n  required_checks: ci\n', /required_checks must be a list/],
    ['a non-string check', 'landing:\n  required_checks: [1]\n', /required_checks must be a list/],
  ])('%s → bad-landing with no gh call', (_case, stack, error) => {
    const { result, calls } = land(checkout({ ...WORKFLOW_FILE, '.dev/stack.yml': stack }))
    expect(result.status).toBe('bad-landing')
    expect(result.error).toMatch(error)
    expect(calls).toEqual([])
  })
})

describe('readLanding', () => {
  it('keeps a quoted # inside a check name', () => {
    expect(readLanding(checkout({ '.dev/stack.yml': 'landing:\n  required_checks: ["ci #1"]\n' }))).toEqual({
      mode: 'native',
      required_checks: ['ci #1'],
    })
  })

  it('no stack and no workflow file is native', () => {
    expect(readLanding(checkout())).toEqual({ mode: 'native', required_checks: [] })
  })
})

describe('ci-watch real path', () => {
  it('a copy of the script alone exits 70 naming the real-path fix, with no gh call', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-watch-orphan-'))
    const orphan = join(dir, 'ci-watch.sh')
    writeFileSync(orphan, readFileSync(CI_WATCH))
    chmodSync(orphan, 0o755)
    const log = join(dir, 'gh.log')
    writeFileSync(
      join(dir, 'gh'),
      `#!/usr/bin/env bash\necho "$*" >> "${log}"\necho '{"state":"MERGED","mergeStateStatus":"UNKNOWN","autoMergeRequest":null,"labels":[],"headRefOid":"abc","statusCheckRollup":[]}'\n`,
    )
    chmodSync(join(dir, 'gh'), 0o755)
    let code = 0
    let stderr = ''
    try {
      execFileSync('bash', [orphan, '7', '--merge-mode', 'merge-on-green', '--repo', 'acme/app', '--timeout', '1s'], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      })
    } catch (error) {
      if (error && typeof error === 'object' && 'status' in error) {
        code = /** @type {{ status: number; stderr?: string }} */ (error).status
        stderr = /** @type {{ stderr?: string }} */ (error).stderr ?? ''
      } else throw error
    }
    expect(code).toBe(70)
    expect(stderr).toContain(
      'ci-watch: run this script from its real path (realpath skill://ci-watch/ci-watch.sh) — cannot find ../feature/workflow.js',
    )
    expect(existsSync(log) ? readFileSync(log, 'utf8') : '').toBe('')
  })
})
