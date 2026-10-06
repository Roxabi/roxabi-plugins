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
const BEFORE_AT = '2026-09-29T09:00:00Z'
const EVENTS_JQ = '.[] | select(.event == "labeled" and .label.name == "reviewed") | .created_at'

const DRIVER = `
const [mod, fn, cwd, pr, eventsMode, historyMode, prList, headMode] = process.argv.slice(1)
const { landPr, readLanding } = await import(mod)
if (fn === 'readLanding') {
  try {
    console.log(JSON.stringify(readLanding(cwd)))
  } catch (e) {
    console.log(JSON.stringify({ error: e.message }))
  }
  process.exit(0)
}
const ME = 'omp-bot'
const review = (verdict) => '<!-- omp-build:code-review -->\\n<!-- omp-build:review-head sha=0123456789abcdef0123456789abcdef01234567 -->\\n## Code Review\\n\\n**Verdict: ' + verdict + '** — summary'
// approved: a first-round green. unapproved: a red latest record at the current head.
// spent: a third red, which exhausts the bound.
const HISTORIES = {
  approved: [review('Approve (clean)')],
  unapproved: [review('Request changes')],
  spent: [review('Request changes'), review('Request changes'), review('Request changes')],
}
const comments = HISTORIES[historyMode].map((body) => ({ author: { login: ME }, body }))
const calls = []
let eventsPoll = 0
let headReads = 0
const sleep = async () => {}
const same = (args, expected) => args.length === expected.length && expected.every((arg, i) => args[i] === arg)
const gh = async (_cwd, args) => {
  calls.push(args)
  if (same(args, ['api', 'user', '--jq', '.login'])) return ME + '\\n'
  if (args[0] === 'pr' && args[1] === 'list') return prList
  if (args[0] === 'repo') return JSON.stringify({ nameWithOwner: 'acme/app' })
  if (args[0] === 'pr' && args[1] === 'view') {
    const view = {}
    for (const field of String(args[4]).split(',')) {
      if (field === 'comments') view.comments = comments
      if (field === 'labels') view.labels = []
      if (field === 'headRefName') view.headRefName = 'feat/7-widget'
      if (field === 'autoMergeRequest') view.autoMergeRequest = null
      if (field === 'state') view.state = 'OPEN'
      if (field === 'baseRefName') view.baseRefName = 'main'
      if (field === 'headRefOid') {
        headReads++
        view.headRefOid =
          headMode === 'moved' && headReads > 1
            ? 'fedcba9876543210fedcba9876543210fedcba98'
            : '0123456789abcdef0123456789abcdef01234567'
      }
    }
    return JSON.stringify(view)
  }
  if (args[0] === 'api' && String(args[1] ?? '').includes('/events')) {
    eventsPoll++
    if (eventsMode === 'fail') throw new Error('HTTP 500')
    if (eventsMode === 'empty') return ''
    if (eventsMode === 'lag') {
      // before + two stale post-add reads, then the new event
      if (eventsPoll <= 3) return '${BEFORE_AT}'
      return '${BEFORE_AT}\\n${EVENT_AT}\\n'
    }
    if (eventsMode === 'stuck') return '${BEFORE_AT}'
    // ok: first call (before) empty, later the new event
    if (eventsPoll === 1) return ''
    return '${EVENT_AT}\\n'
  }
  if (same(args, ['api', '--paginate', '--slurp', 'repos/{owner}/{repo}/issues/7/comments'])) {
    return JSON.stringify([comments.map((entry, index) => ({ user: { login: entry.author.login }, body: entry.body, created_at: '2026-01-01T00:00:0' + index + 'Z' }))])
  }
  if (args[0] === 'api') throw new Error('HTTP 403')
  return ''
}
try {
  const result = await landPr(cwd, pr === '' ? undefined : Number(pr), { gh, sleep })
  console.log(JSON.stringify({ result, calls }))
} catch (e) {
  console.log(JSON.stringify({ error: e.message, calls }))
}
`

/** Hook-inherited GIT_* would point git at the caller's repository instead of this one. */
function gitEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
}

/** A checkout with the given files, relative path → content; a git repository unless `repo: false`. */
function checkout(files = {}, { repo = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'land-seam-'))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  if (repo) execFileSync('git', ['init', '-q'], { cwd: dir, env: gitEnv() })
  return dir
}

/** `pr: ''` omits the PR, so landPr discovers it from the checkout's branch. */
function land(cwd, eventsMode = 'ok', { pr = '7', history = 'approved', prList = '[]', head = '' } = {}) {
  return JSON.parse(
    execFileSync('bun', ['-e', DRIVER, WORKFLOW, 'landPr', cwd, pr, eventsMode, history, prList, head], {
      encoding: 'utf8',
    }),
  )
}

function readLanding(cwd) {
  return JSON.parse(execFileSync('bun', ['-e', DRIVER, WORKFLOW, 'readLanding', cwd], { encoding: 'utf8' }))
}

const BRANCH = 'feat/637-review-action-sinks'

/** A checkout that is a git repository on BRANCH (unborn — `branch --show-current` needs no commit). */
function onBranch(files) {
  const dir = checkout(files)
  execFileSync('git', ['symbolic-ref', 'HEAD', `refs/heads/${BRANCH}`], { cwd: dir, env: gitEnv() })
  return dir
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
const IDENTITY = ['api', 'user', '--jq', '.login']
const COMMENTS = ['api', '--paginate', '--slurp', 'repos/{owner}/{repo}/issues/7/comments']
const GATE = ['pr', 'view', '7', '--json', 'headRefOid,headRefName,state,labels,autoMergeRequest']
const LIST = ['pr', 'list', '--head', BRANCH, '--state', 'all', '--json', 'number,state,isCrossRepository']
const STACK = { ...WORKFLOW_FILE, '.dev/stack.yml': 'runtime: bun\n' }
const WATCH_FAILED = {
  status: 'watch-failed',
  error: 'could not read the labeled reviewed event after re-label — merge-on-green needs --since from GitHub',
}

/** The calls were the review-history read — login and comments, in either order — then the gate read, and nothing else. */
function onlyDecidingReads(calls) {
  expect(calls).toHaveLength(3)
  expect(calls).toEqual(expect.arrayContaining([IDENTITY, COMMENTS, GATE]))
}

describe('landPr through the checkout', () => {
  it('a merge-on-green workflow and a stack with no landing block watch merge-on-green, asking no rules API', () => {
    const { result, calls } = land(checkout({ ...WORKFLOW_FILE, '.dev/stack.yml': 'runtime: bun\n' }))
    expect(result).toMatchObject({ status: 'watching', mode: 'merge-on-green' })
    const script = watchScript(result.watch)
    expect(script.startsWith('/')).toBe(true)
    expect(existsSync(script)).toBe(true)
    expect(result.watch).toBe(`bash '${script}' '7' --merge-mode merge-on-green --since ${EVENT_AT}`)
    // The absolute path is the real ci-watch.sh: a pure hook works from a cwd outside the plugin.
    const outside = mkdtempSync(join(tmpdir(), 'land-watch-cwd-'))
    expect(
      execFileSync('bash', [script, '--classify-checks'], {
        encoding: 'utf8',
        cwd: outside,
        input: '[]',
      }).trim(),
    ).toBe('PENDING')
    // review gate (identity + comments), the PR gate, then before events + labels,
    // a fresh head read, then the label.
    // Stub answers protection/rules; a probe would show.
    expect(calls).toEqual([
      IDENTITY,
      COMMENTS,
      GATE,
      ['repo', 'view', '--json', 'nameWithOwner'],
      EVENTS,
      ['pr', 'view', '7', '--json', 'labels'],
      ['pr', 'view', '7', '--json', 'headRefOid'],
      ['pr', 'edit', '7', '--add-label', 'reviewed'],
      ['repo', 'view', '--json', 'nameWithOwner'],
      EVENTS,
    ])
  })
  it('a head that moves after the labels view is not-approved and writes nothing', () => {
    const { result, calls } = land(checkout(STACK), 'ok', { head: 'moved' })
    expect(result).toEqual({ status: 'not-approved', reviews: 1, reason: 'head-moved' })
    expect(calls.some((args) => args[1] === 'edit')).toBe(false)
  })

  it('events read failing returns watch-failed, never watching without --since', () => {
    const { result, calls } = land(checkout({ ...WORKFLOW_FILE, '.dev/stack.yml': 'runtime: bun\n' }), 'fail')
    expect(result).toEqual(WATCH_FAILED)
    expect(calls.some((a) => a[0] === 'pr' && a.includes('--add-label'))).toBe(true)
    expect(calls.filter((a) => a[0] === 'api' && String(a[1]).includes('/events')).length).toBeGreaterThan(1)
  })

  it('events read empty returns watch-failed', () => {
    const { result } = land(checkout({ ...WORKFLOW_FILE, '.dev/stack.yml': 'runtime: bun\n' }), 'empty')
    expect(result).toEqual(WATCH_FAILED)
  })

  it('a lagging events API eventually yields watching with the newer --since', () => {
    const { result, calls } = land(checkout({ ...WORKFLOW_FILE, '.dev/stack.yml': 'runtime: bun\n' }), 'lag')
    expect(result).toMatchObject({ status: 'watching', mode: 'merge-on-green' })
    expect(result.watch).toContain(`--since ${EVENT_AT}`)
    expect(calls.filter((a) => a[0] === 'api' && String(a[1]).includes('/events')).length).toBe(4)
  })

  it('retries that only ever see the pre-label time return watch-failed', () => {
    const { result, calls } = land(checkout({ ...WORKFLOW_FILE, '.dev/stack.yml': 'runtime: bun\n' }), 'stuck')
    expect(result).toEqual(WATCH_FAILED)
    expect(calls.filter((a) => a[0] === 'api' && String(a[1]).includes('/events')).length).toBe(6)
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
    ['a non-map document', '- a\n', /the document is not a map/],
    ['an unknown mode', 'landing:\n  mode: auto\n', /landing\.mode must be native or merge-on-green/],
    ['required_checks not a list', 'landing:\n  required_checks: ci\n', /required_checks must be a list/],
    ['a non-string check', 'landing:\n  required_checks: [1]\n', /required_checks must be a list/],
    ['an empty check name', 'landing:\n  required_checks: [""]\n', /required_checks must be a list/],
  ])('%s → bad-landing after the head check, before any gate write', (_case, stack, error) => {
    const { result, calls } = land(checkout({ ...WORKFLOW_FILE, '.dev/stack.yml': stack }))
    expect(result.status).toBe('bad-landing')
    expect(result.error).toMatch(error)
    expect(calls).toEqual([IDENTITY, COMMENTS, GATE])
    expect(calls.some((a) => a[1] === 'edit' || a[1] === 'merge')).toBe(false)
  })

  it('a comment-only stack with the workflow file watches merge-on-green', () => {
    const { result } = land(checkout({ ...WORKFLOW_FILE, '.dev/stack.yml': '# only a comment\n' }))
    expect(result).toMatchObject({ status: 'watching', mode: 'merge-on-green' })
  })
})

describe('landPr review gate through the checkout', () => {
  const CONFIGS = [
    ['merge-on-green', STACK],
    ['native with no required contexts', { '.dev/stack.yml': 'landing:\n  mode: native\n' }],
    ['an invalid landing', { '.dev/stack.yml': 'landing:\n  mode: auto\n' }],
  ]

  it.each(CONFIGS)('a spent history under %s is not-approved by the review bound and never armed', (_mode, files) => {
    const { result, calls } = land(checkout(files), 'ok', { history: 'spent' })
    expect(result).toEqual({ status: 'not-approved', reviews: 3, reason: 'review-bound' })
    onlyDecidingReads(calls)
  })

  it.each(CONFIGS)(
    'an unapproved history under %s is not-approved after the history and gate reads alone',
    (_mode, files) => {
      const { result, calls } = land(checkout(files), 'ok', { history: 'unapproved' })
      expect(result).toEqual({ status: 'not-approved', reviews: 1 })
      onlyDecidingReads(calls)
    },
  )

  it.each([
    ['no PR', '[]'],
    ['only a merged PR', JSON.stringify([{ number: 6, state: 'MERGED', isCrossRepository: false }])],
  ])('an omitted PR on a branch with %s is no-pr, and nothing else is asked', (_label, prList) => {
    const { result, calls } = land(onBranch(STACK), 'ok', { pr: '', prList })
    expect(result).toEqual({ status: 'no-pr' })
    expect(calls).toEqual([LIST])
  })

  it('an omitted PR resolves to the branch’s one open PR, whose history the gate reads', () => {
    const prList = JSON.stringify([{ number: 7, state: 'OPEN', isCrossRepository: false }])
    const { result, calls } = land(onBranch(STACK), 'ok', { pr: '', prList })
    expect(result).toMatchObject({ status: 'watching', mode: 'merge-on-green' })
    expect(calls[0]).toEqual(LIST)
    expect(calls).toContainEqual(COMMENTS)
  })

  it.each([
    [
      'two open PRs',
      [
        { number: 7, state: 'OPEN', isCrossRepository: false },
        { number: 8, state: 'OPEN', isCrossRepository: false },
      ],
    ],
    ['only a closed PR, whose budget a new PR would reset', [{ number: 7, state: 'CLOSED', isCrossRepository: false }]],
  ])('an omitted PR on a branch with %s fails, and nothing is armed', (_label, prs) => {
    const { result, error, calls } = land(onBranch(STACK), 'ok', { pr: '', prList: JSON.stringify(prs) })
    expect(result).toBeUndefined()
    expect(error).toEqual(expect.any(String))
    expect(calls).toEqual([LIST])
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

describe('landPr proof gate through real git', () => {
  const SEMCTX = {
    ...STACK,
    '.semctx/semantic/changes/widget.sem': 'change change.widget\n  status: verified\n  tag: issue-7\n',
  }

  it('a semctx repository whose caller supplies no proof is proof-blocked, and nothing is written', () => {
    const { result, calls } = land(checkout(SEMCTX))
    expect(result).toEqual({ status: 'proof-blocked', reason: 'no proof supplied' })
    onlyDecidingReads(calls)
  })

  it('a directory that is not a git checkout is refused rather than landed unchecked', () => {
    const { result, calls } = land(checkout(STACK, { repo: false }))
    expect(result).toEqual({ status: 'proof-blocked', reason: 'no-repo-root' })
    onlyDecidingReads(calls)
  })

  it('a repository without .semctx lands without a proof', () => {
    expect(land(checkout(STACK)).result).toMatchObject({ status: 'watching', mode: 'merge-on-green' })
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
