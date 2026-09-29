import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// `.dev/stack.yml` is parsed with Bun.YAML, which the vitest worker does not
// have: every case runs the real module under bun.
const WORKFLOW = join(import.meta.dirname, 'workflow.js')

const DRIVER = `
const [mod, fn, cwd, pr] = process.argv.slice(1)
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

function land(cwd) {
  return JSON.parse(execFileSync('bun', ['-e', DRIVER, WORKFLOW, 'landPr', cwd, '7'], { encoding: 'utf8' }))
}

function readLanding(cwd) {
  return JSON.parse(execFileSync('bun', ['-e', DRIVER, WORKFLOW, 'readLanding', cwd], { encoding: 'utf8' }))
}

const WORKFLOW_FILE = { '.github/workflows/merge-on-green.yml': 'name: merge-on-green\n' }
const PROTECTION = ['api', 'repos/acme/app/branches/main/protection/required_status_checks']
const RULES = ['api', 'repos/acme/app/rules/branches/main']

describe('landPr through the checkout', () => {
  it('a merge-on-green workflow and a stack with no landing block watch merge-on-green', () => {
    const { result, calls } = land(checkout({ ...WORKFLOW_FILE, '.dev/stack.yml': 'runtime: bun\n' }))
    expect(result).toMatchObject({ status: 'watching', mode: 'merge-on-green' })
    expect(result.watch).toContain('--merge-mode merge-on-green')
    expect(calls).toContainEqual(['pr', 'edit', '7', '--add-label', 'reviewed'])
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
