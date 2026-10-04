import { describe, expect, it } from 'vitest'
import {
  analyzeReviewHistory,
  applyCiWatchExit,
  commentPageArgs,
  createReviewLoop,
  interpretReviewHistory,
  landPr,
  MAX_FIX_ROUNDS,
  openPr,
  readReviewRounds,
  resolveReviewPr,
  resumeReviewLoop,
} from './workflow.js'

/**
 * Every call goes through an injected client. Nothing here can reach a real `gh`,
 * so no test can open, label or merge a pull request — the same posture
 * `land.test.js` takes with `landPr(cwd, pr, { gh })`.
 */
function ghError(spec) {
  if (typeof spec === 'string') return new Error(spec)
  const { message, ...payload } = spec
  return Object.assign(new Error(message), payload)
}

function mockGh({
  list = '[]',
  create = JSON.stringify({ number: 512 }),
  listThrows = null,
  createThrows = null,
} = {}) {
  const calls = []
  let listCall = 0
  const gh = async (_cwd, args) => {
    calls.push(args)
    if (args[0] === 'pr' && args[1] === 'list') {
      if (listThrows) throw ghError(listThrows)
      const responses = Array.isArray(list) ? list : [list]
      const response = responses[Math.min(listCall, responses.length - 1)]
      listCall++
      return response
    }
    if (args[0] === 'api') {
      if (createThrows) throw ghError(createThrows)
      return create
    }
    throw new Error(`unexpected gh call: ${args.join(' ')}`)
  }
  return { gh, calls }
}

const CWD = '/tmp/wt'
const PR = 512
const ME = 'omp-bot'
const BRANCH = 'feat/637-review-action-sinks'
/** The one query the automation login comes from. */
const IDENTITY = ['api', 'user', '--jq', '.login']
/** How a review finds the branch's PRs: every state, so a closed PR still counts. @param {string} branch */
const discovery = (branch) => [
  'pr',
  'list',
  '--head',
  branch,
  '--state',
  'all',
  '--json',
  'number,state,isCrossRepository',
]
/** One entry of that answer. @param {number} number @param {string} [state] @param {boolean} [cross] */
const listing = (number, state = 'OPEN', cross = false) => ({ number, state, isCrossRepository: cross })
/** A native landing with one declared required check. */
const NATIVE = { mode: 'native', required_checks: ['ci'] }

/** @param {unknown[]} args @param {unknown[]} expected */
function same(args, expected) {
  return args.length === expected.length && expected.every((arg, i) => args[i] === arg)
}

/** A PR comment as `gh pr view --json comments` returns it. @param {string} body @param {string} [author] */
function comment(body, author = ME) {
  return { author: { login: author }, body }
}

/**
 * A review record as dev-review posts it: the marker on the first line, the verdict last.
 * @param {string} verdict
 * @param {{ before?: string }} [opts] a line placed above the verdict
 */
function review(verdict, { before } = {}) {
  return [
    '<!-- omp-build:code-review -->',
    '<!-- omp-build:review-head sha=0123456789abcdef0123456789abcdef01234567 -->',
    '## Code Review',
    '',
    '## Spec',
    '',
    '- ✓ criterion met',
    ...(before === undefined ? [] : ['', before]),
    '',
    `**Verdict: ${verdict}** — summary`,
  ].join('\n')
}

const RED = review('Request changes')
const GREEN = review('Approve (clean)')
const RECEIPT = '## Review Fixes Applied\n\n**Applied:** 1 cause(s)'

/** What `persist` and `enforceStop` write. @param {number} reviews @param {number} fixes @param {string} [stop] */
function accounting(reviews, fixes, stop) {
  return [
    `<!-- omp-build:review-rounds reviews=${reviews} fixes=${fixes} -->`,
    ...(stop === undefined ? [] : [`<!-- omp-build:review-stop reason=${stop} -->`]),
    `Review bound: ${reviews} review(s), ${fixes} of 2 fix round(s) spent.`,
  ].join('\n')
}

/** Two completed rounds: each red persisted as an allocation, each fix receipted. */
const TWO_ROUNDS = [
  comment(RED),
  comment(accounting(1, 1)),
  comment(RECEIPT),
  comment(RED),
  comment(accounting(2, 2)),
  comment(RECEIPT),
]

/** PR #636 as it stands: one review record and a prose dossier — no counters, no receipts. */
const PR_636 = [
  comment(
    '<!-- omp-build:code-review -->\n## Code Review\n\nRound 3 (final), at head `61808f2c`.\n\n**Verdict: Request changes** — 1 blocking finding in 1 root cause (RC-1).',
  ),
  comment('## Human intervention required — review did not converge\n\nThe PR applies its own rule to itself.'),
]

/**
 * One PR as `gh` shows it, and the branch `git` is on. Stateful: `pr comment` posts as
 * whoever the identity query names; label and auto-merge writes change what the next view
 * reads. Only exact argv is answered — anything else throws, so a wrong query can never
 * read as an empty history. Nothing here reaches a real `gh` or `git`.
 */
function fakePr({
  me = ME,
  comments = [],
  labels = [],
  autoMerge = null,
  state = 'OPEN',
  branch = BRANCH,
  /** The branch's PRs as `gh pr list --state all` lists them, a raw answer, or the Error the lookup throws. */
  branchPrs = [listing(PR, state)],
} = {}) {
  const pr = {
    me,
    comments: [...comments],
    labels: new Set(labels),
    autoMerge,
    state,
    branch,
    branchPrs,
    headRefOid: '0123456789abcdef0123456789abcdef01234567',
  }
  const n = String(PR)
  const calls = []
  const gh = async (_cwd, args) => {
    calls.push(args)
    if (same(args, IDENTITY)) return `${pr.me}\n`
    if (same(args, discovery(pr.branch))) {
      if (pr.branchPrs instanceof Error) throw pr.branchPrs
      return typeof pr.branchPrs === 'string' ? pr.branchPrs : JSON.stringify(pr.branchPrs)
    }
    if (same(args, commentPageArgs(n))) {
      return JSON.stringify([
        pr.comments.map((entry, index) => ({
          user: { login: entry.author.login },
          body: entry.body,
          created_at: `2026-01-01T00:00:${String(index).padStart(2, '0')}Z`,
        })),
      ])
    }
    if (args.length === 5 && same(args.slice(0, 4), ['pr', 'view', n, '--json'])) {
      /** @type {Record<string, unknown>} */
      const view = {}
      for (const field of args[4].split(',')) {
        if (field === 'comments') view.comments = pr.comments
        else if (field === 'labels') view.labels = [...pr.labels].map((name) => ({ name }))
        else if (field === 'autoMergeRequest') view.autoMergeRequest = pr.autoMerge
        else if (field === 'state') view.state = pr.state
        else if (field === 'headRefOid') view.headRefOid = pr.headRefOid
        else throw new Error(`unexpected field: ${field}`)
      }
      return JSON.stringify(view)
    }
    if (args.length === 5 && same(args.slice(0, 4), ['pr', 'comment', n, '--body'])) {
      pr.comments.push(comment(args[4], pr.me))
      return ''
    }
    if (same(args, ['pr', 'edit', n, '--remove-label', 'reviewed'])) {
      pr.labels.delete('reviewed')
      return ''
    }
    if (same(args, ['pr', 'edit', n, '--add-label', 'reviewed'])) {
      pr.labels.add('reviewed')
      return ''
    }
    if (same(args, ['pr', 'merge', n, '--disable-auto'])) {
      pr.autoMerge = null
      return ''
    }
    if (same(args, ['pr', 'merge', n, '--auto', '--merge'])) {
      pr.autoMerge = { mergeMethod: 'MERGE' }
      return ''
    }
    if (
      args.length === 7 &&
      same(args.slice(0, 5), ['pr', 'merge', n, '--auto', '--merge']) &&
      args[5] === '--match-head-commit'
    ) {
      pr.autoMerge = { mergeMethod: 'MERGE' }
      return ''
    }
    throw new Error(`unexpected gh call: ${args.join(' ')}`)
  }
  const git = async (_cwd, args) => {
    calls.push(['git', ...args])
    if (same(args, ['branch', '--show-current'])) return pr.branch
    if (same(args, ['rev-parse', 'HEAD'])) return `${pr.localHead ?? pr.headRefOid}\n`
    throw new Error(`unexpected git call: ${args.join(' ')}`)
  }
  /** A record posted outside the loop: dev-review's review, fix's receipt, another session. */
  const post = (body, author = pr.me) => {
    pr.comments.push(comment(body, author))
  }
  return { gh, git, calls, pr, post }
}

/** @param {{ gh: Function, git: Function }} fake */
const deps = ({ gh, git }) => ({ gh, git })

/** The strict durable read, through the same PR. */
const strict = (fake) => readReviewRounds(CWD, PR, { gh: fake.gh })

/** dev-review posts its record; the loop records that verdict and persists it (§6.4). */
async function reviewed(loop, fake, verdict) {
  fake.post(verdict === 'red' ? RED : GREEN)
  const step = loop.record(verdict)
  await loop.persist(CWD)
  return step
}

/** The awaited fix guard, then fix posts its receipt. */
async function fixed(loop, fake, step) {
  const granted = await loop.assertFixAllowed(CWD, step)
  fake.post(RECEIPT)
  return granted
}

/** A loop resumed on an unreviewed PR and driven to its first or second persisted red allocation. */
async function allocate(fake, round) {
  const loop = await resumeReviewLoop(CWD, { pr: PR, gh: fake.gh })
  let step = await reviewed(loop, fake, 'red')
  if (round === 2) {
    await fixed(loop, fake, step)
    step = await reviewed(loop, fake, 'red')
  }
  return { loop, step }
}

/** The rejection of `promise`; a resolution fails the test. */
async function refusal(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected a refusal, got a grant')
}

const INPUT = { issue: 494, branch: 'feat/494-feature-back-half', base: 'staging', title: 'feat: back half' }

/**
 * The idempotency key, spelled out. `openPr` never opens a second PR *because* this is
 * the lookup it makes: a wrong `--head`, a dropped `--base`, `--state all` or a `--json`
 * without `number` each turn "one already open" into "none open", and the next answer is
 * a duplicate PR. So the argv is asserted element by element, not just its effect.
 */
const LOOKUP = [
  'pr',
  'list',
  '--head',
  INPUT.branch,
  '--base',
  INPUT.base,
  '--state',
  'open',
  '--json',
  'number,isCrossRepository',
]

function created(calls) {
  return calls.filter((args) => args[0] === 'api')
}

function fieldOf(args, key) {
  const i = args.findIndex((arg) => typeof arg === 'string' && arg.startsWith(`${key}=`))
  return i === -1 ? null : args[i].slice(key.length + 1)
}

describe('openPr', () => {
  it('returns the number the client reported, not a number read out of text', async () => {
    const { gh, calls } = mockGh({ create: JSON.stringify({ html_url: 'https://x/pull/999', number: 512 }) })
    expect(await openPr('/tmp/wt', INPUT, { gh })).toEqual({ number: 512, status: 'created' })
    // `html_url` carries a number too, and it comes first in the response: anything
    // that reads digits out of the text rather than the `number` field returns 999.
    expect(created(calls)).toHaveLength(1)
    expect(fieldOf(created(calls)[0], 'head')).toBe('feat/494-feature-back-half')
    expect(fieldOf(created(calls)[0], 'base')).toBe('staging')
  })

  it('links the ticket with a closing keyword the promote harvester reads', async () => {
    const { gh, calls } = mockGh()
    await openPr('/tmp/wt', { ...INPUT, body: 'Back half of the cycle.' }, { gh })
    expect(fieldOf(created(calls)[0], 'body')).toBe('Back half of the cycle.\n\nCloses #494')
  })

  it('does not duplicate a closing keyword the caller already wrote', async () => {
    const { gh, calls } = mockGh()
    await openPr('/tmp/wt', { ...INPUT, body: 'Fixes #494 — the back half.' }, { gh })
    expect(fieldOf(created(calls)[0], 'body')).toBe('Fixes #494 — the back half.')
  })

  it('reuses the PR already open for that head, and opens nothing', async () => {
    const { gh, calls } = mockGh({ list: JSON.stringify([{ number: 400, isCrossRepository: false }]) })
    expect(await openPr('/tmp/wt', INPUT, { gh })).toEqual({ number: 400, status: 'existing' })
    expect(calls).toEqual([LOOKUP])
  })

  it('picks the oldest when the head somehow carries two open PRs', async () => {
    const { gh, calls } = mockGh({
      list: JSON.stringify([
        { number: 640, isCrossRepository: false },
        { number: 400, isCrossRepository: false },
      ]),
    })
    expect(await openPr('/tmp/wt', INPUT, { gh })).toEqual({ number: 400, status: 'existing' })
    expect(calls).toEqual([LOOKUP])
  })

  it('never reuses a fork PR that carries the same head name', async () => {
    // `--head` matches a fork's branch too: reusing it would review and land a stranger's commits.
    const { gh, calls } = mockGh({ list: JSON.stringify([{ number: 401, isCrossRepository: true }]) })
    expect(await openPr('/tmp/wt', INPUT, { gh })).toMatchObject({ status: 'created' })
    expect(created(calls)).toHaveLength(1)
  })

  it.each([
    ['an omitted flag', { number: 401 }],
    ['a null flag', { number: 401, isCrossRepository: null }],
    ['a string flag', { number: 401, isCrossRepository: 'false' }],
  ])('throws and creates nothing when a positive number has %s', async (_label, entry) => {
    // `true` is dropped by both a strict boolean check and `!== true`. These three
    // are kept by the loose filter, so replacing the shared guard reuses the entry.
    const { gh, calls } = mockGh({ list: JSON.stringify([entry]) })
    await expect(openPr('/tmp/wt', INPUT, { gh })).rejects.toThrow(/invalid PR discovery response/)
    expect(created(calls)).toHaveLength(0)
  })

  it('re-reads on GitHub\u2019s own 422, classified on the exit payload', async () => {
    // The realistic client failure: `gh` exits non-zero with the API's JSON body.
    const { gh, calls } = mockGh({
      list: ['[]', JSON.stringify([{ number: 402, isCrossRepository: false }])],
      createThrows: {
        message: 'gh api --method POST repos/{owner}/{repo}/pulls … failed (1)',
        exitCode: 1,
        stderr:
          'gh: Validation Failed (HTTP 422)\n{"message":"Validation Failed","errors":[{"message":"A pull request already exists for Roxabi:feat/494-feature-back-half."}]}',
      },
    })
    expect(await openPr('/tmp/wt', INPUT, { gh })).toEqual({ number: 402, status: 'existing' })
    expect(calls.filter((args) => args[0] === 'pr')).toEqual([LOOKUP, LOOKUP])
  })

  it('does not read the race out of the title it was handed', async () => {
    // The rendered message embeds the argv, and the argv carries `title=`/`body=` —
    // caller input. A PR whose own title says "a pull request already exists" must not
    // be able to turn an unrelated 403 into a race, and re-look-up a PR that is not
    // there: the failure has to propagate.
    const input = { ...INPUT, title: 'fix: a pull request already exists on re-entry' }
    const { gh, calls } = mockGh({
      list: ['[]', JSON.stringify([{ number: 403, isCrossRepository: false }])],
      createThrows:
        'gh api --method POST … -f title=fix: a pull request already exists on re-entry failed (1): HTTP 403 — resource not accessible by integration',
    })
    await expect(openPr('/tmp/wt', input, { gh })).rejects.toThrow(/resource not accessible/)
    expect(calls.filter((args) => args[0] === 'pr')).toEqual([LOOKUP])
  })

  it('does not read the race out of the body it was handed', async () => {
    const body = 'Re-entry is safe: a pull request already exists for this head, and openPr reuses it.'
    const { gh, calls } = mockGh({
      list: ['[]', JSON.stringify([{ number: 404, isCrossRepository: false }])],
      createThrows: {
        message: 'gh api --method POST … failed (1): gh: Not Found (HTTP 404)',
        stderr: 'gh: Not Found (HTTP 404)',
      },
    })
    await expect(openPr('/tmp/wt', { ...INPUT, body }, { gh })).rejects.toThrow(/HTTP 404/)
    expect(calls.filter((args) => args[0] === 'pr')).toEqual([LOOKUP])
  })

  it('re-reads instead of failing when another opener wins the race', async () => {
    const { gh, calls } = mockGh({
      list: ['[]', JSON.stringify([{ number: 401, isCrossRepository: false }])],
      createThrows: 'gh api failed (1): A pull request already exists for Roxabi:feat/494-feature-back-half.',
    })
    expect(await openPr('/tmp/wt', INPUT, { gh })).toEqual({ number: 401, status: 'existing' })
    expect(created(calls)).toHaveLength(1)
  })

  it('propagates the client error when the create fails for any other reason', async () => {
    const { gh } = mockGh({ createThrows: 'gh api failed (1): HTTP 403 — resource not accessible' })
    await expect(openPr('/tmp/wt', INPUT, { gh })).rejects.toThrow(/HTTP 403/)
  })

  it('propagates the client error when the lookup itself fails', async () => {
    const { gh, calls } = mockGh({ listThrows: 'gh pr list failed (1): could not resolve to a Repository' })
    await expect(openPr('/tmp/wt', INPUT, { gh })).rejects.toThrow(/could not resolve/)
    expect(created(calls)).toEqual([])
  })

  it('refuses a create response that carries no number', async () => {
    const { gh } = mockGh({ create: JSON.stringify({ html_url: 'https://x/pull/512' }) })
    await expect(openPr('/tmp/wt', INPUT, { gh })).rejects.toThrow(/carried no PR number/)
  })

  it('refuses a create response that is not JSON', async () => {
    const { gh } = mockGh({ create: 'https://github.com/Roxabi/roxabi-plugins/pull/512' })
    await expect(openPr('/tmp/wt', INPUT, { gh })).rejects.toThrow(/returned no JSON/)
  })

  it('refuses a lookup response that is not JSON at all, rather than opening a second PR', async () => {
    const { gh, calls } = mockGh({ list: 'no pull requests match your search' })
    await expect(openPr('/tmp/wt', INPUT, { gh })).rejects.toThrow(/returned no JSON/)
    expect(created(calls)).toEqual([])
  })

  it.each([
    ['null', 'null'],
    ['a single object', '{"number":400}'],
  ])('refuses a lookup response that parses but is not an array (%s)', async (_label, list) => {
    // `null` and a bare object both survive `JSON.parse`; only the array check stops
    // them, and "not an array" read as "none open" opens the duplicate.
    const { gh, calls } = mockGh({ list })
    await expect(openPr('/tmp/wt', INPUT, { gh })).rejects.toThrow(/returned no array/)
    expect(created(calls)).toEqual([])
  })

  it.each([
    ['no number field', JSON.stringify([{ title: 'feat: back half' }])],
    ['a zero', '[{"number":0}]'],
    ['a negative number', '[{"number":-4}]'],
  ])('refuses a lookup entry with %s', async (_label, list) => {
    const { gh, calls } = mockGh({ list })
    await expect(openPr('/tmp/wt', INPUT, { gh })).rejects.toThrow(/no PR number/)
    expect(created(calls)).toEqual([])
  })

  it.each([
    ['issue', { ...INPUT, issue: 0 }],
    ['issue', { ...INPUT, issue: 'the back half' }],
    ['branch', { ...INPUT, branch: '' }],
    ['base', { ...INPUT, base: undefined }],
    ['title', { ...INPUT, title: '   ' }],
  ])('refuses a missing %s before reaching the client', async (_label, input) => {
    const { gh, calls } = mockGh()
    await expect(openPr('/tmp/wt', input, { gh })).rejects.toThrow(TypeError)
    expect(calls).toEqual([])
  })
})

describe('createReviewLoop — local count semantics', () => {
  it('lands on the first green without a fix round', () => {
    expect(createReviewLoop().record('green')).toEqual({ action: 'land', reviews: 1, fixes: 0 })
  })

  it('lands after one red and one fix', () => {
    const loop = createReviewLoop()
    expect(loop.record('red')).toEqual({ action: 'fix', reviews: 1, fixes: 1, remaining: 1 })
    expect(loop.record('green')).toEqual({ action: 'land', reviews: 2, fixes: 1 })
  })

  it('lands after two spent fix rounds when the third review is green', () => {
    const loop = createReviewLoop()
    expect(loop.record('red').action).toBe('fix')
    expect(loop.record('red')).toEqual({ action: 'fix', reviews: 2, fixes: 2, remaining: 0 })
    expect(loop.record('green')).toEqual({ action: 'land', reviews: 3, fixes: 2 })
  })

  it('stops on the third red with the rounds it spent', () => {
    const loop = createReviewLoop()
    loop.record('red')
    loop.record('red')
    expect(loop.record('red')).toMatchObject({ action: 'stop', reason: 'review-bound', reviews: 3, fixes: 2 })
    expect(loop.stopReason).toBe('review-bound')
  })

  it('never yields land after the bound, however many verdicts arrive', () => {
    // The defect: an agent that keeps re-reviewing until something comes back green.
    const loop = createReviewLoop()
    loop.record('red')
    loop.record('red')
    expect(loop.record('red').action).toBe('stop')
    expect(() => loop.record('green')).toThrow()
    expect({ closed: loop.closed, reviews: loop.reviews }).toEqual({ closed: 'stop', reviews: 3 })
  })

  it('refuses a further verdict once it has landed', () => {
    const loop = createReviewLoop()
    expect(loop.record('green').action).toBe('land')
    expect(() => loop.record('red')).toThrow()
    expect({ closed: loop.closed, reviews: loop.reviews, fixes: loop.fixes }).toEqual({
      closed: 'land',
      reviews: 1,
      fixes: 0,
    })
  })

  it('counts rounds itself, so a caller cannot restart them', () => {
    const loop = createReviewLoop()
    loop.record('red')
    loop.record('red')
    expect(loop.reviews).toBe(2)
    expect(loop.fixes).toBe(2)
    expect(loop.record('red').action).toBe('stop')
  })

  it.each(['review: green', 'GREEN ✅', '', 'maybe', null, undefined, 3])(
    'refuses %o as a verdict rather than guessing one',
    (verdict) => {
      const loop = createReviewLoop()
      expect(() => loop.record(verdict)).toThrow(TypeError)
      expect(loop.reviews).toBe(0)
    },
  )

  it('accepts the verdict word whatever its case or padding', () => {
    expect(createReviewLoop().record('  Green ').action).toBe('land')
    expect(createReviewLoop().record('RED').action).toBe('fix')
  })

  it('bounds at two fix rounds', () => {
    expect(MAX_FIX_ROUNDS).toBe(2)
    const loop = createReviewLoop()
    let rounds = 0
    let step = loop.record('red')
    while (step.action === 'fix') {
      rounds++
      step = loop.record('red')
    }
    expect(rounds).toBe(MAX_FIX_ROUNDS)
    expect(step.action).toBe('stop')
  })

  it('says how many rounds are left after each red under a tighter bound', () => {
    const loop = createReviewLoop({ maxFixRounds: 1 })
    expect(loop.record('red')).toEqual({ action: 'fix', reviews: 1, fixes: 1, remaining: 0 })
    expect(loop.record('red').action).toBe('stop')
  })

  it.each([-1, 1.5])('refuses a bound of %o that is not a count', (maxFixRounds) => {
    expect(() => createReviewLoop({ maxFixRounds })).toThrow()
  })

  it('refuses seeded counts that are not counts', () => {
    expect(() => createReviewLoop({ fixes: -1 })).toThrow(TypeError)
    expect(() => createReviewLoop({ reviews: 1.5 })).toThrow(TypeError)
    expect(() => createReviewLoop({ stopReason: 'STOP!' })).toThrow(TypeError)
  })

  it('keeps a recovered count above the ceiling conservative: a red stops, never allocates', () => {
    const loop = createReviewLoop({ reviews: 4, fixes: 3 })
    expect(loop.record('red')).toMatchObject({ action: 'stop', fixes: 3 })
    expect(loop.pendingFix).toBe(false)
  })
})

describe('MAX_FIX_ROUNDS is a policy ceiling, not a default', () => {
  it.each([3, 99])('refuses maxFixRounds=%i at every public entry', async (maxFixRounds) => {
    // A widened bound would read this stopped history as open, and allocate a third round.
    const fake = fakePr({ comments: [...TWO_ROUNDS, comment(RED)] })
    expect(() => createReviewLoop({ maxFixRounds })).toThrow()
    expect(() => interpretReviewHistory(fake.pr.comments, { me: ME, maxFixRounds })).toThrow()
    await expect(readReviewRounds(CWD, PR, { gh: fake.gh, maxFixRounds })).rejects.toThrow()
    await expect(resumeReviewLoop(CWD, { pr: PR, gh: fake.gh, maxFixRounds })).rejects.toThrow()
  })
})

describe('reopen after ci-failed — spends a round, never refunds one', () => {
  it('re-opens a landing by spending a fix round, and stops once none is left', () => {
    // §6.7's ci-failed row: green → land → landPr says ci-failed → back to §6.5.
    const loop = createReviewLoop()
    expect(loop.record('red')).toMatchObject({ action: 'fix', fixes: 1 })
    expect(loop.record('green').action).toBe('land')
    expect(loop.reopen('ci-failed')).toEqual({ action: 'fix', reviews: 2, fixes: 2, remaining: 0, reason: 'ci-failed' })
    expect(loop.closed).toBe(null)
    expect(loop.record('green').action).toBe('land')
    expect(loop.reopen('ci-failed')).toMatchObject({ action: 'stop', reason: 'ci-failed', fixes: MAX_FIX_ROUNDS })
    expect(() => loop.record('green')).toThrow()
  })

  it('costs a round even when every verdict so far was green', () => {
    const loop = createReviewLoop()
    loop.record('green')
    expect(loop.reopen('ci-failed')).toEqual({ action: 'fix', reviews: 1, fixes: 1, remaining: 1, reason: 'ci-failed' })
  })

  it('only re-opens a landing, and only for a CI failure', () => {
    const landed = createReviewLoop()
    landed.record('green')
    expect(() => landed.reopen('timeout')).toThrow(TypeError)
    expect(landed.closed).toBe('land')
    const unreviewed = createReviewLoop()
    expect(() => unreviewed.reopen('ci-failed')).toThrow()
    expect(unreviewed.fixes).toBe(0)
    const red = createReviewLoop()
    red.record('red')
    expect(() => red.reopen('ci-failed')).toThrow()
    expect(red.fixes).toBe(1)
  })

  it('cannot lift a sticky stop', () => {
    const loop = createReviewLoop()
    loop.record('red')
    loop.record('red')
    loop.record('red')
    expect(() => loop.reopen('ci-failed')).toThrow()
    expect({ closed: loop.closed, stopReason: loop.stopReason, fixes: loop.fixes }).toEqual({
      closed: 'stop',
      stopReason: 'review-bound',
      fixes: 2,
    })
  })
})

describe('resolveReviewPr — one PR, resolved before any loop exists', () => {
  const LIST = discovery(BRANCH)

  it.each([512, '512'])('takes an explicit PR %o without asking git or gh', async (explicit) => {
    const fake = fakePr()
    expect(await resolveReviewPr(CWD, explicit, deps(fake))).toBe(512)
    expect(fake.calls).toEqual([])
  })

  it.each([null, undefined, ''])('discovers the open PR of the current branch for %o', async (explicit) => {
    const fake = fakePr({ branchPrs: [listing(640)] })
    expect(await resolveReviewPr(CWD, explicit, deps(fake))).toBe(640)
    // Any PR for this head, whatever its base: a `--base` would miss one opened against another base.
    expect(fake.calls).toEqual([['git', 'branch', '--show-current'], LIST])
  })

  it('takes the one open PR even when merged and closed PRs share its head', async () => {
    const fake = fakePr({ branchPrs: [listing(400, 'MERGED'), listing(300, 'CLOSED'), listing(640)] })
    expect(await resolveReviewPr(CWD, null, deps(fake))).toBe(640)
  })

  it.each([
    ['no PR at all', []],
    ['only merged PRs', [listing(400, 'MERGED'), listing(401, 'MERGED')]],
  ])('answers null — a genuinely local review — when the branch has %s', async (_label, branchPrs) => {
    expect(await resolveReviewPr(CWD, null, deps(fakePr({ branchPrs })))).toBe(null)
  })

  it.each([
    ['a closed PR', [listing(512, 'CLOSED')]],
    ['a closed PR beside a merged one', [listing(400, 'MERGED'), listing(512, 'CLOSED')]],
  ])('refuses a branch with no open PR but %s: reusing that head would reset its budget', async (_label, branchPrs) => {
    await expect(resolveReviewPr(CWD, null, deps(fakePr({ branchPrs })))).rejects.toThrow()
  })

  it.each([
    ['the lookup fails', { branchPrs: new Error('HTTP 502') }],
    ['the lookup is not JSON', { branchPrs: 'no pull requests match your search' }],
    ['the lookup is not an array', { branchPrs: JSON.stringify(listing(512)) }],
    ['an entry carries an unknown state', { branchPrs: JSON.stringify([listing(512, 'DRAFT')]) }],
    ['two PRs are open for the branch', { branchPrs: [listing(512), listing(640)] }],
    ['HEAD is detached', { branch: '' }],
  ])('refuses when %s — a failed lookup is not "no PR"', async (_label, options) => {
    await expect(resolveReviewPr(CWD, null, deps(fakePr(options)))).rejects.toThrow()
  })

  it('an entry with no state but a same-repository flag is an invalid discovery response', async () => {
    const fake = fakePr({ branchPrs: JSON.stringify([{ number: 512, isCrossRepository: false }]) })
    await expect(resolveReviewPr(CWD, null, deps(fake))).rejects.toThrow(/invalid PR discovery response/)
  })

  it.each([
    ['no PR number', { title: 'feat: sinks', state: 'OPEN', isCrossRepository: false }],
    ['a zero', { number: 0, state: 'OPEN', isCrossRepository: false }],
    ['a non-integer', { number: '12', state: 'OPEN', isCrossRepository: false }],
  ])('refuses an entry with %s once the fork flag is present', async (_label, entry) => {
    const fake = fakePr({ branchPrs: JSON.stringify([entry]) })
    await expect(resolveReviewPr(CWD, null, deps(fake))).rejects.toThrow(/invalid PR discovery response/)
  })

  it.each([0, -3, 'abc', 1.5])('refuses an explicit %o instead of discovering some other PR', async (explicit) => {
    const fake = fakePr()
    await expect(resolveReviewPr(CWD, explicit, deps(fake))).rejects.toThrow()
    expect(fake.calls).toEqual([])
  })
})

describe('assertFixAllowed on a PR-less loop — proves there is no PR first', () => {
  it('grants the live allocation once when the branch has no PR', async () => {
    const fake = fakePr({ branchPrs: [] })
    const loop = createReviewLoop()
    const step = loop.record('red')
    await expect(loop.assertFixAllowed(CWD, step, deps(fake))).resolves.toBe(step)
    await expect(loop.assertFixAllowed(CWD, step, deps(fake))).rejects.toThrow()
  })

  it('runs the second local allocation at fixes=2 once; the third red stops', async () => {
    const fake = fakePr({ branchPrs: [] })
    const loop = createReviewLoop()
    await loop.assertFixAllowed(CWD, loop.record('red'), deps(fake))
    const second = loop.record('red')
    expect(second).toEqual({ action: 'fix', reviews: 2, fixes: 2, remaining: 0 })
    await expect(loop.assertFixAllowed(CWD, second, deps(fake))).resolves.toBe(second)
    await expect(loop.assertFixAllowed(CWD, second, deps(fake))).rejects.toThrow()
    expect(loop.record('red').action).toBe('stop')
    await expect(loop.assertFixAllowed(CWD, second, deps(fake))).rejects.toThrow()
  })

  it('refuses when the branch already has an open PR: that PR must be resumed, not bypassed', async () => {
    const fake = fakePr({ comments: [...TWO_ROUNDS, comment(RED)] })
    const loop = createReviewLoop()
    const step = loop.record('red')
    await expect(loop.assertFixAllowed(CWD, step, deps(fake))).rejects.toThrow()
    expect(fake.calls).toContainEqual(discovery(BRANCH))
    expect(fake.pr.comments).toHaveLength(TWO_ROUNDS.length + 1)
    // The way in is the PR loop, and that PR is stopped.
    expect((await resumeReviewLoop(CWD, { pr: PR, gh: fake.gh })).closed).toBe('stop')
  })

  it.each([
    ['the lookup fails', { branchPrs: new Error('HTTP 502') }],
    ['two PRs are open for the branch', { branchPrs: [listing(512), listing(640)] }],
    ['the branch’s only PR was closed', { branchPrs: [listing(PR, 'CLOSED')] }],
    ['HEAD is detached', { branch: '' }],
  ])('refuses when %s: a local fix needs a branch proven free of open and closed PRs', async (_label, options) => {
    const loop = createReviewLoop()
    const step = loop.record('red')
    await expect(loop.assertFixAllowed(CWD, step, deps(fakePr(options)))).rejects.toThrow()
  })

  it('sends a ci-failed round through the same discovery: refused beside an open PR, granted without one', async () => {
    const loop = createReviewLoop()
    loop.record('green')
    const step = loop.reopen('ci-failed')
    await expect(loop.assertFixAllowed(CWD, step, deps(fakePr()))).rejects.toThrow()
    await expect(loop.assertFixAllowed(CWD, step, deps(fakePr({ branchPrs: [] })))).resolves.toBe(step)
  })
})

describe('assertFixAllowed on a PR loop — fresh history at the fix sink', () => {
  it('grants the first persisted red allocation once, and only posts its grant marker', async () => {
    const fake = fakePr({ labels: ['size:F-lite'] })
    const { loop, step } = await allocate(fake, 1)
    expect(step).toEqual({ action: 'fix', reviews: 1, fixes: 1, remaining: 1 })
    await expect(loop.assertFixAllowed(CWD, step)).resolves.toBe(step)
    await expect(loop.assertFixAllowed(CWD, step)).rejects.toThrow()
    expect(loop.closed).toBe(null)
    expect([...fake.pr.labels]).toEqual(['size:F-lite'])
    expect(await strict(fake)).toEqual({ reviews: 1, fixes: 1 })
  })

  it('grants the live second red at fixes=2 once; a resume does not replay it', async () => {
    const fake = fakePr()
    const { loop, step } = await allocate(fake, 2)
    expect(step).toEqual({ action: 'fix', reviews: 2, fixes: 2, remaining: 0 })

    // The allocation is persisted and the receipt is not posted yet. That is not a
    // terminal red: the resume has no live grant, and it is not sticky-stopped.
    const resumed = await resumeReviewLoop(CWD, { pr: PR, gh: fake.gh })
    expect({ closed: resumed.closed, stopReason: resumed.stopReason, pendingFix: resumed.pendingFix }).toEqual({
      closed: null,
      stopReason: undefined,
      pendingFix: false,
    })
    await expect(resumed.assertFixAllowed(CWD, step)).rejects.toThrow()

    await expect(loop.assertFixAllowed(CWD, step)).resolves.toBe(step)
    await expect(loop.assertFixAllowed(CWD, step)).rejects.toThrow()
  })

  it('lands the final green after two fixes, through the same sinks', async () => {
    const fake = fakePr()
    const { loop, step } = await allocate(fake, 2)
    await fixed(loop, fake, step)
    expect(await reviewed(loop, fake, 'green')).toEqual({ action: 'land', reviews: 3, fixes: 2 })
    expect(await strict(fake)).toEqual({ reviews: 3, fixes: 2 })
    const land = await landPr(CWD, PR, { gh: fake.gh, landing: { mode: 'native', required_checks: ['ci'] } })
    expect(land).toMatchObject({ status: 'watching', mode: 'native' })
    expect(fake.pr.labels.has('reviewed')).toBe(true)
    expect(fake.pr.autoMerge).not.toBe(null)
  })

  it('never replays an earlier allocation on resume as a grant; a newer red supersedes it and allocates the remaining round', async () => {
    // Counter persisted, nobody granted it: a resume may claim it (see #699), never assert it as is.
    const fake = fakePr({ comments: [comment(RED), comment(accounting(1, 1))] })
    const loop = await resumeReviewLoop(CWD, { pr: PR, gh: fake.gh })
    expect({ reviews: loop.reviews, fixes: loop.fixes, pendingFix: loop.pendingFix }).toEqual({
      reviews: 1,
      fixes: 1,
      pendingFix: false,
    })
    await expect(loop.assertFixAllowed(CWD, { action: 'fix', reviews: 1, fixes: 1, remaining: 1 })).rejects.toThrow(
      'no live unconsumed',
    )
    // A newer red is posted: the open allocation is superseded, and recording it counts the new review once.
    fake.post(RED)
    await expect(loop.refreshPersistedFix(CWD)).resolves.toBe(null)
    expect(loop.persistedFix).toBe(null)
    const step = loop.record('red')
    await loop.persist(CWD)
    expect(step).toEqual({ action: 'fix', reviews: 2, fixes: 2, remaining: 0 })
    await expect(loop.assertFixAllowed(CWD, step)).resolves.toBe(step)
  })

  it('expects the posted review records, not the reviews an accounting line counts', async () => {
    // One round was reviewed before the PR existed: the counter says 1, GitHub holds no record of it.
    const fake = fakePr({ comments: [comment(accounting(1, 1))] })
    const loop = await resumeReviewLoop(CWD, { pr: PR, gh: fake.gh })
    const step = await reviewed(loop, fake, 'red')
    expect(step).toEqual({ action: 'fix', reviews: 2, fixes: 2, remaining: 0 })
    await expect(loop.assertFixAllowed(CWD, step)).resolves.toBe(step)
  })

  /** Allocate `round`, then let something else land on the PR before the fix sink runs. */
  const allocateThen = (round, interfere) => async (fake) => {
    const allocation = await allocate(fake, round)
    interfere(fake)
    return allocation
  }

  it.each([
    [
      'another session published an explicit stop',
      allocateThen(1, (fake) => fake.post(accounting(1, 1, 'review-bound'))),
      'review-bound',
    ],
    [
      'receipts the loop never allocated make the history ambiguous',
      allocateThen(1, (fake) => {
        fake.post(RECEIPT)
        fake.post(RECEIPT)
      }),
      'history-ambiguous',
    ],
    [
      'an explicit stop sits at the second allocation, not the loop’s own terminal red',
      allocateThen(2, (fake) => fake.post(accounting(2, 2, 'review-bound'))),
      'review-bound',
    ],
    ['a later review record follows the second allocation', allocateThen(2, (fake) => fake.post(RED)), 'review-bound'],
    // Fresh history holds no stop, yet it does not prove this live allocation: stale, never refunded.
    // A marker that claims the budget, with no red after that allocation's receipt, is not a terminal red.
    [
      'the durable allocation moved past the live loop',
      allocateThen(1, (fake) => fake.post(accounting(2, 2))),
      'history-stale',
    ],
    ['a later review record follows the first allocation', allocateThen(1, (fake) => fake.post(RED)), 'history-stale'],
    [
      'gh answers as another account, even one whose records mirror the loop’s',
      allocateThen(1, (fake) => {
        for (const record of [...fake.pr.comments]) fake.post(record.body, 'omp-bot-2')
        fake.pr.me = 'omp-bot-2'
      }),
      'history-stale',
    ],
  ])('refuses when %s: stops durably and disarms the gate', async (_label, setup, reason) => {
    const fake = fakePr({ labels: ['reviewed'], autoMerge: { mergeMethod: 'MERGE' } })
    const { loop, step } = await setup(fake)
    const error = await refusal(loop.assertFixAllowed(CWD, step))
    expect(error.stop).toMatchObject({
      prState: 'OPEN',
      guaranteed: true,
      published: true,
      removed: true,
      autoMergeDisabled: true,
      disarmErrors: [],
    })
    expect({ closed: loop.closed, stopReason: loop.stopReason }).toEqual({ closed: 'stop', stopReason: reason })
    expect(fake.pr.labels.has('reviewed')).toBe(false)
    expect(fake.pr.autoMerge).toBe(null)
    await expect(loop.assertFixAllowed(CWD, step)).rejects.toThrow()
    // Read as whoever gh answers as now: the account that published the stop.
    expect((await strict(fake)).stopReason).toBe(reason)
  })

  it('throws a recoverable error naming persist when the allocation was recorded but not persisted', async () => {
    const fake = fakePr({ labels: ['reviewed'], autoMerge: { mergeMethod: 'MERGE' } })
    const loop = await resumeReviewLoop(CWD, { pr: PR, gh: fake.gh })
    fake.post(RED)
    const step = loop.record('red')
    const before = fake.pr.comments.map((entry) => entry.body)
    const error = await refusal(loop.assertFixAllowed(CWD, step))
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain('persist')
    expect(error.stop).toBeUndefined()
    expect(loop.closed).toBe(null)
    expect(loop.pendingFix).toBe(true)
    expect(fake.pr.comments.map((entry) => entry.body)).toEqual(before)
    expect(fake.pr.labels.has('reviewed')).toBe(true)
    expect(fake.pr.autoMerge).not.toBe(null)
    await loop.persist(CWD)
    await expect(loop.assertFixAllowed(CWD, step)).resolves.toBe(step)
  })

  it('throws a recoverable error when record lands during the history read', async () => {
    const fake = fakePr({ labels: ['reviewed'], autoMerge: { mergeMethod: 'MERGE' } })
    const loop = await resumeReviewLoop(CWD, { pr: PR, gh: fake.gh })
    fake.post(RED)
    const step = loop.record('red')
    await loop.persist(CWD)
    let drifted = false
    const pages = commentPageArgs(PR)
    const gh = async (cwd, args) => {
      const result = await fake.gh(cwd, args)
      if (!drifted && same(args, pages)) {
        drifted = true
        fake.post(RED)
        loop.record('red')
      }
      return result
    }
    const before = fake.pr.comments.map((entry) => entry.body)
    const error = await refusal(loop.assertFixAllowed(CWD, step, { gh }))
    expect(error.message).toContain('persist')
    expect(error.stop).toBeUndefined()
    expect(loop.closed).toBe(null)
    expect(loop.pendingFix).toBe(true)
    expect(fake.pr.labels.has('reviewed')).toBe(true)
    expect(fake.pr.autoMerge).not.toBe(null)
    expect(fake.pr.comments.slice(0, before.length).map((entry) => entry.body)).toEqual(before)
    expect(fake.pr.comments.at(-1).body).toBe(RED)
    expect(fake.pr.comments.some((entry) => entry.body.includes('review-stop'))).toBe(false)
  })

  it('throws a recoverable error when a ci-failed allocation was not persisted', async () => {
    const fake = fakePr({ labels: ['reviewed'], autoMerge: { mergeMethod: 'MERGE' } })
    const loop = await resumeReviewLoop(CWD, { pr: PR, gh: fake.gh })
    expect((await reviewed(loop, fake, 'green')).action).toBe('land')
    const step = loop.reopen('ci-failed')
    const before = fake.pr.comments.map((entry) => entry.body)
    const error = await refusal(loop.assertFixAllowed(CWD, step))
    expect(error.message).toContain('persist')
    expect(error.stop).toBeUndefined()
    expect(loop.closed).toBe(null)
    expect(loop.pendingFix).toBe(true)
    expect(fake.pr.comments.map((entry) => entry.body)).toEqual(before)
    expect(fake.pr.labels.has('reviewed')).toBe(true)
    expect(fake.pr.autoMerge).not.toBe(null)
    await loop.persist(CWD)
    await expect(loop.assertFixAllowed(CWD, step)).resolves.toBe(step)
  })

  it('leaves the allocation unpersisted when record lands during persist', async () => {
    const fake = fakePr({ labels: ['reviewed'], autoMerge: { mergeMethod: 'MERGE' } })
    const loop = await resumeReviewLoop(CWD, { pr: PR, gh: fake.gh })
    fake.post(RED)
    loop.record('red')
    let during
    const gh = async (cwd, args) => {
      if (!during && args[0] === 'pr' && args[1] === 'comment') {
        fake.post(RED)
        during = loop.record('red')
      }
      return fake.gh(cwd, args)
    }
    await loop.persist(CWD, { gh })
    const written = fake.pr.comments.map((entry) => entry.body)
    expect(written.some((body) => body.includes('reviews=1'))).toBe(true)
    expect(written.some((body) => body.includes('reviews=2'))).toBe(false)
    const error = await refusal(loop.assertFixAllowed(CWD, during))
    expect(error.message).toContain('persist')
    expect(error.stop).toBeUndefined()
    expect(loop.closed).toBe(null)
    expect(loop.pendingFix).toBe(true)
    expect(fake.pr.labels.has('reviewed')).toBe(true)
    expect(fake.pr.autoMerge).not.toBe(null)
    await loop.persist(CWD)
    await expect(loop.assertFixAllowed(CWD, during)).resolves.toBe(during)
  })

  it('stops when the review is missing between persist and the grant', async () => {
    const fake = fakePr({ labels: ['reviewed'], autoMerge: { mergeMethod: 'MERGE' } })
    const loop = await resumeReviewLoop(CWD, { pr: PR, gh: fake.gh })
    fake.post(RED)
    const step = loop.record('red')
    await loop.persist(CWD)
    const reviewAt = fake.pr.comments.findIndex((entry) => entry.body.startsWith('<!-- omp-build:code-review -->'))
    fake.pr.comments.splice(reviewAt, 1)
    const error = await refusal(loop.assertFixAllowed(CWD, step))
    expect(error.stop).toMatchObject({ published: true, removed: true, autoMergeDisabled: true })
    expect(loop.stopReason).toBe('history-stale')
    expect(fake.pr.labels.has('reviewed')).toBe(false)
    expect((await strict(fake)).stopReason).toBe('history-stale')
  })

  it('lists caller-order errors and writes nothing for each', async () => {
    const missing = fakePr({ labels: ['reviewed'], autoMerge: { mergeMethod: 'MERGE' } })
    const missingLoop = await resumeReviewLoop(CWD, { pr: PR, gh: missing.gh })
    missing.post(RED)
    const missingStep = missingLoop.record('red')
    const missingBefore = missing.pr.comments.map((entry) => entry.body)
    const missingError = await refusal(missingLoop.assertFixAllowed(CWD, missingStep))

    const reused = fakePr()
    const { loop: reusedLoop, step: reusedStep } = await allocate(reused, 1)
    const reusedBefore = reused.pr.comments.length
    const reusedError = await refusal(reusedLoop.assertFixAllowed(CWD, { ...reusedStep }))

    const stopped = fakePr({ comments: [...TWO_ROUNDS, comment(RED)] })
    const stoppedBefore = stopped.pr.comments.length
    const stoppedLoop = await resumeReviewLoop(CWD, { pr: PR, gh: stopped.gh })
    let stoppedError
    try {
      stoppedLoop.record('red')
    } catch (error) {
      stoppedError = error
    }

    expect([missingError.message, reusedError.message, stoppedError.message]).toEqual([
      'assertFixAllowed: call persist before assertFixAllowed — this live allocation is not on the PR yet',
      'assertFixAllowed: step does not match the live allocation',
      'createReviewLoop: the loop already closed with "stop" after 3 reviews — a further verdict has nowhere to go',
    ])
    expect(missingError.stop).toBeUndefined()
    expect(reusedError.stop).toBeUndefined()
    expect(missing.pr.comments.map((entry) => entry.body)).toEqual(missingBefore)
    expect(missing.pr.labels.has('reviewed')).toBe(true)
    expect(missing.pr.autoMerge).not.toBe(null)
    expect(missingLoop.closed).toBe(null)
    expect(missingLoop.pendingFix).toBe(true)
    expect(reused.pr.comments).toHaveLength(reusedBefore)
    expect(reusedLoop.pendingFix).toBe(true)
    expect(stopped.pr.comments).toHaveLength(stoppedBefore)
    expect(stoppedLoop.closed).toBe('stop')
  })

  it('refuses a copy of the live step without consuming the grant', async () => {
    const fake = fakePr()
    const { loop, step } = await allocate(fake, 1)
    await expect(loop.assertFixAllowed(CWD, { ...step })).rejects.toThrow()
    await expect(loop.assertFixAllowed(CWD, step)).resolves.toBe(step)
  })

  it('grants overlapping calls for one step at most once', async () => {
    const fake = fakePr()
    const { loop, step } = await allocate(fake, 1)
    const outcomes = await Promise.allSettled([loop.assertFixAllowed(CWD, step), loop.assertFixAllowed(CWD, step)])
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected'])
  })

  it('never lets a raw createReviewLoop({ pr }) authorize a PR fix — the PR loop must be resumed', async () => {
    const fake = fakePr()
    const raw = createReviewLoop({ pr: PR, gh: fake.gh })
    fake.post(RED)
    const step = raw.record('red')
    await raw.persist(CWD)
    await expect(raw.assertFixAllowed(CWD, step)).rejects.toThrow()
    expect(await strict(fake)).toEqual({ reviews: 1, fixes: 1 })
  })

  it('refuses any step on a resumed stopped PR, which cannot be reopened either', async () => {
    const fake = fakePr({ comments: [...TWO_ROUNDS, comment(RED)] })
    const loop = await resumeReviewLoop(CWD, { pr: PR, gh: fake.gh })
    expect(loop.stopReason).toBe('review-bound')
    await expect(loop.assertFixAllowed(CWD, { action: 'fix', reviews: 3, fixes: 2, remaining: 0 })).rejects.toThrow()
    expect(() => loop.reopen('ci-failed')).toThrow()
    expect(() => loop.record('green')).toThrow()
    expect(loop.closed).toBe('stop')
  })

  it('authorizes a ci-failed round through the same fresh guard, without counting a review', async () => {
    const fake = fakePr({ comments: [comment(RED), comment(accounting(1, 1)), comment(RECEIPT)] })
    const loop = await resumeReviewLoop(CWD, { pr: PR, gh: fake.gh })
    expect((await reviewed(loop, fake, 'green')).action).toBe('land')
    const step = loop.reopen('ci-failed')
    expect(step).toEqual({ action: 'fix', reviews: 2, fixes: 2, remaining: 0, reason: 'ci-failed' })
    await loop.persist(CWD)
    await expect(loop.assertFixAllowed(CWD, step)).resolves.toBe(step)
  })

  it('refuses the ci-failed round once a red review follows the approval', async () => {
    const fake = fakePr({ comments: [comment(RED), comment(accounting(1, 1)), comment(RECEIPT)] })
    const loop = await resumeReviewLoop(CWD, { pr: PR, gh: fake.gh })
    await reviewed(loop, fake, 'green')
    const step = loop.reopen('ci-failed')
    await loop.persist(CWD)
    fake.post(RED)
    await expect(loop.assertFixAllowed(CWD, step)).rejects.toThrow()
  })

  /**
   * Green → landPr → CI red → reopen('ci-failed') → CI fix → red → second grant → receipt.
   * The CI fix posts no receipt, so the allocation markers run ahead of the receipts.
   */
  async function ciFixThenRedFix(fake) {
    const loop = await resumeReviewLoop(CWD, { pr: PR, gh: fake.gh })
    expect((await reviewed(loop, fake, 'green')).action).toBe('land')
    expect(await landPr(CWD, PR, { gh: fake.gh, landing: NATIVE })).toMatchObject({ status: 'watching' })
    expect(await applyCiWatchExit(CWD, PR, 1, { mode: 'native', gh: fake.gh })).toEqual({
      status: 'ci-failed',
      disarmed: true,
    })
    const ciFix = loop.reopen('ci-failed')
    expect(ciFix).toEqual({ action: 'fix', reviews: 1, fixes: 1, remaining: 1, reason: 'ci-failed' })
    await loop.persist(CWD)
    await expect(loop.assertFixAllowed(CWD, ciFix)).resolves.toBe(ciFix)
    // The CI fix is pushed and no review has judged it yet: nothing may re-arm.
    expect(await landPr(CWD, PR, { gh: fake.gh, landing: NATIVE })).toEqual({
      status: 'not-approved',
      reviews: 1,
      fixes: 1,
    })
    expect({ labeled: fake.pr.labels.has('reviewed'), autoMerge: fake.pr.autoMerge }).toEqual({
      labeled: false,
      autoMerge: null,
    })
    const redFix = await reviewed(loop, fake, 'red')
    expect(redFix).toEqual({ action: 'fix', reviews: 2, fixes: 2, remaining: 0 })
    await fixed(loop, fake, redFix)
    return loop
  }

  it('lands the re-reviewed correction after a CI fix spent the first round', async () => {
    const fake = fakePr()
    const loop = await ciFixThenRedFix(fake)
    expect(await reviewed(loop, fake, 'green')).toEqual({ action: 'land', reviews: 3, fixes: 2 })
    expect(await strict(fake)).toEqual({ reviews: 3, fixes: 2 })
    const land = await landPr(CWD, PR, { gh: fake.gh, landing: NATIVE })
    expect(land).toMatchObject({ status: 'watching', mode: 'native' })
    expect(fake.pr.labels.has('reviewed')).toBe(true)
    expect(fake.pr.autoMerge).not.toBe(null)
  })

  it('stops on a round-3 red after a CI fix and a red fix, and landing refuses it', async () => {
    const fake = fakePr()
    const loop = await ciFixThenRedFix(fake)
    fake.post(RED)
    expect(loop.record('red')).toMatchObject({ action: 'stop', reason: 'review-bound', reviews: 3, fixes: 2 })
    expect(await loop.enforceStop(CWD)).toMatchObject({ prState: 'OPEN', guaranteed: true, published: true })
    expect(await strict(fake)).toEqual({ reviews: 3, fixes: 2, stopReason: 'review-bound' })
    expect(await landPr(CWD, PR, { gh: fake.gh, landing: NATIVE })).toMatchObject({
      status: 'review-stopped',
      reason: 'review-bound',
    })
    expect(fake.pr.labels.has('reviewed')).toBe(false)
    expect(fake.pr.autoMerge).toBe(null)
    expect((await resumeReviewLoop(CWD, { pr: PR, gh: fake.gh })).stopReason).toBe('review-bound')
  })
})

describe('enforceStop — reads the gate, then publishes and disarms independently', () => {
  const stopped = () => {
    const loop = createReviewLoop({ pr: PR })
    loop.record('red')
    loop.record('red')
    loop.record('red')
    return loop
  }

  it('publishes the stop on an open PR, disarms what it found, and guarantees the gate', async () => {
    const fake = fakePr({ labels: ['reviewed', 'size:F-full'], autoMerge: { mergeMethod: 'MERGE' } })
    const outcome = await stopped().enforceStop(CWD, { gh: fake.gh })
    expect(outcome).toMatchObject({
      prState: 'OPEN',
      guaranteed: true,
      published: true,
      publishError: null,
      readError: null,
      removed: true,
      autoMergeDisabled: true,
      disarmErrors: [],
    })
    expect([...fake.pr.labels]).toEqual(['size:F-full'])
    expect(fake.pr.autoMerge).toBe(null)
    expect((await strict(fake)).stopReason).toBe('review-bound')
  })

  it('publishes the stop and writes nothing else when the open PR carries no gate', async () => {
    const fake = fakePr({ labels: ['size:F-full'] })
    const outcome = await stopped().enforceStop(CWD, { gh: fake.gh })
    expect(outcome).toMatchObject({
      prState: 'OPEN',
      guaranteed: true,
      published: true,
      removed: false,
      autoMergeDisabled: false,
      labels: ['size:F-full'],
    })
    expect(fake.calls.some((args) => args[1] === 'edit' || args[1] === 'merge')).toBe(false)
  })

  it.each(['MERGED', 'CLOSED'])('changes nothing on a %s PR, and reports its state', async (state) => {
    const fake = fakePr({ state, labels: ['reviewed'], autoMerge: { mergeMethod: 'MERGE' } })
    const outcome = await stopped().enforceStop(CWD, { gh: fake.gh })
    expect(outcome).toMatchObject({
      prState: state,
      guaranteed: false,
      published: false,
      removed: false,
      autoMergeDisabled: false,
    })
    expect(fake.pr.comments).toEqual([])
    expect(fake.pr.labels.has('reviewed')).toBe(true)
    expect(fake.pr.autoMerge).toEqual({ mergeMethod: 'MERGE' })
  })

  it.each([
    ['not JSON', 'gh: could not find pull request'],
    ['without labels', JSON.stringify({ state: 'OPEN', autoMergeRequest: null })],
    ['without a known state', JSON.stringify({ labels: [], autoMergeRequest: null })],
  ])('treats a gate read %s as unknown: still publishes and attempts both disarms', async (_label, answer) => {
    const fake = fakePr({ labels: ['reviewed'], autoMerge: { mergeMethod: 'MERGE' } })
    const gh = async (cwd, args) => (args[0] === 'pr' && args[1] === 'view' ? answer : fake.gh(cwd, args))
    const outcome = await stopped().enforceStop(CWD, { gh })
    expect(outcome).toMatchObject({
      prState: null,
      guaranteed: false,
      readError: expect.any(String),
      published: true,
      removed: true,
      autoMergeDisabled: true,
    })
    expect(fake.pr.labels.has('reviewed')).toBe(false)
    expect(fake.pr.autoMerge).toBe(null)
  })

  it('disarms even when publishing the stop fails, and reports the publication error', async () => {
    const fake = fakePr({ labels: ['reviewed', 'size:F-full'] })
    const gh = async (cwd, args) => {
      if (args[1] === 'comment') throw new Error('comment 502')
      return fake.gh(cwd, args)
    }
    const outcome = await stopped().enforceStop(CWD, { gh })
    expect(outcome).toMatchObject({
      guaranteed: false,
      published: false,
      publishError: expect.stringContaining('comment 502'),
      removed: true,
      readError: null,
      disarmErrors: [],
    })
    expect([...fake.pr.labels]).toEqual(['size:F-full'])
  })

  it('reports each failed disarm step without skipping the other', async () => {
    const fake = fakePr({ labels: ['reviewed'], autoMerge: { mergeMethod: 'MERGE' } })
    const gh = async (cwd, args) => {
      if (args.includes('--remove-label')) throw new Error('label ACL denied')
      if (args.includes('--disable-auto')) throw new Error('disable-auto 403')
      return fake.gh(cwd, args)
    }
    const outcome = await stopped().enforceStop(CWD, { gh })
    expect(outcome).toMatchObject({ guaranteed: false, published: true, removed: false, autoMergeDisabled: false })
    expect(outcome.disarmErrors).toEqual([
      expect.stringContaining('label ACL denied'),
      expect.stringContaining('disable-auto 403'),
    ])
  })

  it('refuses to enforce a stop that has not happened', async () => {
    const fake = fakePr()
    const loop = createReviewLoop({ pr: PR })
    await expect(loop.enforceStop(CWD, { gh: fake.gh })).rejects.toThrow()
    loop.record('green')
    await expect(loop.enforceStop(CWD, { gh: fake.gh })).rejects.toThrow()
    expect(fake.calls).toEqual([])
  })

  it('resumes #636-shaped history as a history-ambiguous stop, publishes it, and stays stopped', async () => {
    const fake = fakePr({ comments: PR_636, labels: ['reviewed'] })
    const loop = await resumeReviewLoop(CWD, { pr: PR, gh: fake.gh })
    expect({ closed: loop.closed, stopReason: loop.stopReason }).toEqual({
      closed: 'stop',
      stopReason: 'history-ambiguous',
    })
    expect(await loop.enforceStop(CWD)).toMatchObject({ prState: 'OPEN', published: true, removed: true })
    expect(fake.pr.labels.has('reviewed')).toBe(false)
    expect((await strict(fake)).stopReason).toBe('history-ambiguous')
  })

  it('persists a ci-failed stop, and a resumed session re-disarms a re-added label', async () => {
    const fake = fakePr({ comments: TWO_ROUNDS })
    const loop = await resumeReviewLoop(CWD, { pr: PR, gh: fake.gh })
    expect((await reviewed(loop, fake, 'green')).action).toBe('land')
    expect(loop.reopen('ci-failed')).toMatchObject({ action: 'stop', reason: 'ci-failed' })
    await loop.enforceStop(CWD)
    expect(await strict(fake)).toMatchObject({ reviews: 3, fixes: 2, stopReason: 'ci-failed' })

    fake.pr.labels.add('reviewed')
    const resumed = await resumeReviewLoop(CWD, { pr: PR, gh: fake.gh })
    expect(resumed.stopReason).toBe('ci-failed')
    expect((await resumed.enforceStop(CWD)).removed).toBe(true)
    expect(fake.pr.labels.has('reviewed')).toBe(false)
  })
})

describe('the count outlives the process that holds it', () => {
  it('resumes a loop on its last round instead of handing out two fresh ones', async () => {
    const loop = await resumeReviewLoop(CWD, { pr: PR, gh: fakePr({ comments: TWO_ROUNDS }).gh })
    expect({ reviews: loop.reviews, fixes: loop.fixes, remaining: loop.remaining }).toEqual({
      reviews: 2,
      fixes: 2,
      remaining: 0,
    })
    expect(loop.record('red').action).toBe('stop')
  })

  it('writes a zero baseline on an empty PR once: a review posted before a persist is not legacy', async () => {
    // Another account's record and a plain comment are not this account's history.
    const fake = fakePr({ comments: [comment('a plain comment'), comment(RED, 'attacker')] })
    const loop = await resumeReviewLoop(CWD, { pr: PR, gh: fake.gh })
    expect({ reviews: loop.reviews, fixes: loop.fixes, closed: loop.closed }).toEqual({
      reviews: 0,
      fixes: 0,
      closed: null,
    })
    await resumeReviewLoop(CWD, { pr: PR, gh: fake.gh })
    expect(fake.pr.comments).toHaveLength(3)
    // dev-review posted round 1, then the session died before §6.4 persisted its verdict.
    fake.post(RED)
    expect(await strict(fake)).toEqual({ reviews: 1, fixes: 0 })
    expect((await resumeReviewLoop(CWD, { pr: PR, gh: fake.gh })).closed).toBe(null)
  })

  it('publishes a stop reached in the flow, and a fresh session stays closed even on green', async () => {
    const fake = fakePr({ comments: TWO_ROUNDS })
    const loop = await resumeReviewLoop(CWD, { pr: PR, gh: fake.gh })
    fake.post(RED)
    expect(loop.record('red')).toMatchObject({ action: 'stop', reason: 'review-bound', reviews: 3, fixes: 2 })
    await loop.enforceStop(CWD)
    fake.post(GREEN)
    const resumed = await resumeReviewLoop(CWD, { pr: PR, gh: fake.gh })
    expect(resumed.stopReason).toBe('review-bound')
    expect(() => resumed.record('green')).toThrow()
  })

  it.each([
    ['not JSON', 'gh: not found'],
    ['without comments', JSON.stringify({ labels: [] })],
    ['with comments that are not a list', JSON.stringify({ comments: null })],
  ])('fails closed on a comments answer %s rather than reading "no rounds spent"', async (_label, answer) => {
    const fake = fakePr()
    const view = commentPageArgs(PR)
    const gh = async (cwd, args) => (same(args, view) ? answer : fake.gh(cwd, args))
    await expect(readReviewRounds(CWD, PR, { gh })).rejects.toThrow()
    await expect(resumeReviewLoop(CWD, { pr: PR, gh })).rejects.toThrow()
  })

  it('a Request changes on a later page suppresses an Approve of the current head', async () => {
    const first = [comment(GREEN), comment(accounting(1, 0))]
    const fake = fakePr({ comments: first })
    const pages = [
      first.map((entry, index) => ({
        user: { login: ME },
        body: entry.body,
        created_at: `2026-01-01T00:00:0${index}Z`,
      })),
      [{ user: { login: ME }, body: RED, created_at: '2026-01-01T00:00:09Z' }],
    ]
    const truncated = ['pr', 'view', String(PR), '--json', 'comments']
    const gh = async (cwd, args) => {
      if (same(args, commentPageArgs(PR))) return JSON.stringify(pages)
      if (same(args, truncated)) return JSON.stringify({ comments: first })
      return fake.gh(cwd, args)
    }
    await expect(landPr(CWD, PR, { gh, landing: NATIVE })).resolves.toMatchObject({ status: 'not-approved' })
  })

  it.each([
    ['an empty', '  '],
    ['a JSON-shaped', '{"login":"omp-bot"}'],
    ['a two-line', 'omp-bot\nomp-bot-2'],
  ])('refuses %s answer to the identity query', async (_label, answer) => {
    const fake = fakePr({ comments: TWO_ROUNDS })
    const gh = async (cwd, args) => (same(args, IDENTITY) ? answer : fake.gh(cwd, args))
    await expect(readReviewRounds(CWD, PR, { gh })).rejects.toThrow()
    await expect(resumeReviewLoop(CWD, { pr: PR, gh })).rejects.toThrow()
  })
})

describe('interpretReviewHistory — strict, author-bound, first-line records', () => {
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['blank', '  '],
    ['JSON-shaped', '{"login":"omp-bot"}'],
    ['two-line', 'omp-bot\nomp-bot-2'],
    ['sentence', 'not logged in'],
  ])('refuses a %s automation login', (_label, me) => {
    expect(() => interpretReviewHistory(TWO_ROUNDS, { me })).toThrow()
  })

  it.each([
    ['bot', 'omp-build[bot]'],
    ['Enterprise Managed User', 'octocat_acme'],
  ])('binds to a %s login too', (_label, login) => {
    expect(interpretReviewHistory([comment(RED, login), comment(RECEIPT, login)], { me: login })).toEqual({
      reviews: 1,
      fixes: 1,
    })
  })

  it('refuses a comment entry that is not an object', () => {
    expect(() => interpretReviewHistory([RED], { me: ME })).toThrow(TypeError)
  })

  it('refuses a record by that account whose body is not text', () => {
    expect(() => interpretReviewHistory([{ author: { login: ME }, body: 42 }], { me: ME })).toThrow(TypeError)
  })

  it('takes the highest counts across that account’s accounting records', () => {
    expect(interpretReviewHistory([comment(accounting(2, 2)), comment(accounting(1, 1))], { me: ME })).toEqual({
      reviews: 2,
      fixes: 2,
    })
  })

  it('keeps an explicit stop when a later accounting record lacks it', () => {
    expect(
      interpretReviewHistory([comment(accounting(3, 2, 'review-bound')), comment(accounting(2, 2))], { me: ME }),
    ).toEqual({ reviews: 3, fixes: 2, stopReason: 'review-bound' })
  })

  it('stays open after two completed rounds, for the third review', () => {
    expect(interpretReviewHistory([...TWO_ROUNDS, comment(RED, 'attacker')], { me: ME })).toEqual({
      reviews: 2,
      fixes: 2,
    })
  })

  it('derives review-bound from a third red after two completed rounds', async () => {
    const comments = [...TWO_ROUNDS, comment(RED)]
    expect(interpretReviewHistory(comments, { me: ME })).toEqual({ reviews: 3, fixes: 2, stopReason: 'review-bound' })
    expect((await resumeReviewLoop(CWD, { pr: PR, gh: fakePr({ comments }).gh })).stopReason).toBe('review-bound')
  })

  it('keeps that terminal red sticky when a later review is green', () => {
    expect(
      interpretReviewHistory([...TWO_ROUNDS, comment(RED), comment(GREEN), comment(accounting(4, 2))], { me: ME }),
    ).toMatchObject({ fixes: 2, stopReason: 'review-bound' })
  })

  it.each([
    ['Approve', review('Approve')],
    ['Approve with comments', review('Approve with comments')],
    ['Approve (clean)', GREEN],
  ])('leaves a third %s review after two completed rounds open, so it can land', async (_label, body) => {
    const comments = [...TWO_ROUNDS, comment(body)]
    expect(interpretReviewHistory(comments, { me: ME })).toEqual({ reviews: 3, fixes: 2 })
    const loop = await resumeReviewLoop(CWD, { pr: PR, gh: fakePr({ comments }).gh })
    expect(loop.closed).toBe(null)
    expect(loop.record('green').action).toBe('land')
  })

  it('does not derive review-bound when the second allocation was never receipted', () => {
    // The allocating review precedes its marker. A missing receipt is not a later red.
    expect(interpretReviewHistory(TWO_ROUNDS.slice(0, 5), { me: ME })).toEqual({
      reviews: 2,
      fixes: 2,
    })
  })

  it('derives review-bound from #631-shaped legacy history: three reds, two receipts, no counters', () => {
    expect(
      interpretReviewHistory(
        [comment(RED), comment(RECEIPT), comment(RED), comment(RECEIPT), comment(RED), comment(RECEIPT, 'attacker')],
        { me: ME },
      ),
    ).toEqual({ reviews: 3, fixes: 2, stopReason: 'review-bound' })
  })

  it('keeps legacy receipt-backed rounds open for a final green', () => {
    expect(
      interpretReviewHistory([comment(RED), comment(RECEIPT), comment(RED), comment(RECEIPT), comment(GREEN)], {
        me: ME,
      }),
    ).toEqual({ reviews: 3, fixes: 2 })
  })

  it('counts one receipted legacy round as one spent round', () => {
    expect(interpretReviewHistory([comment(RED), comment(RECEIPT)], { me: ME })).toEqual({ reviews: 1, fixes: 1 })
  })

  it('ignores counters, stops, reviews and receipts posted by another account', () => {
    expect(
      interpretReviewHistory(
        [
          comment(accounting(2, 2), 'attacker'),
          comment(accounting(3, 2, 'review-bound'), 'attacker'),
          comment(RED, 'attacker'),
          comment(RECEIPT, 'attacker'),
          ...TWO_ROUNDS,
        ],
        { me: ME },
      ),
    ).toEqual({ reviews: 2, fixes: 2 })
  })

  it('reads a stop only inside an accounting record (not quoted, fenced, or on a later line)', () => {
    const stop = '<!-- omp-build:review-stop reason=review-bound -->'
    expect(
      interpretReviewHistory(
        [comment(`> ${stop}`), comment(`\`\`\`\n${stop}\n\`\`\``), comment(`Note\n${stop}`), ...TWO_ROUNDS],
        { me: ME },
      ),
    ).toEqual({ reviews: 2, fixes: 2 })
  })

  it('reads a review record only from its first line', () => {
    const quoted = [comment(`Replying to the review:\n${RED}`), comment(`> ${RED.split('\n').join('\n> ')}`)]
    expect(interpretReviewHistory([...TWO_ROUNDS, ...quoted], { me: ME })).toEqual({ reviews: 2, fixes: 2 })
  })

  it('reads a receipt only from its first line', () => {
    expect(
      interpretReviewHistory(
        [
          comment('> ## Review Fixes Applied'),
          comment('```\n## Review Fixes Applied\n```'),
          comment('Note: see ## Review Fixes Applied below'),
        ],
        { me: ME },
      ),
    ).toEqual({ reviews: 0, fixes: 0 })
  })

  it('does not read a quoted verdict as a declaration', () => {
    const body = review('Request changes', { before: '> **Verdict: Approve** — quoted from round 2' })
    expect(interpretReviewHistory([...TWO_ROUNDS, comment(body)], { me: ME })).toEqual({
      reviews: 3,
      fixes: 2,
      stopReason: 'review-bound',
    })
  })

  it.each([
    ['#636 as it stands: a review record and a prose dossier', PR_636, { reviews: 1, fixes: 0 }],
    ['a green review record with no counter', [comment(GREEN)], { reviews: 1, fixes: 0 }],
    ['receipts with no review record', [comment(RECEIPT)], { fixes: 1 }],
    ['more receipts than review records', [comment(RED), comment(RECEIPT), comment(RECEIPT)], { fixes: 2 }],
    [
      'more receipts than the counters allocated',
      [comment(accounting(1, 1)), comment(RECEIPT), comment(RECEIPT)],
      { fixes: 2 },
    ],
    ['an unrecognised verdict', [comment(review('Maybe')), comment(accounting(1, 1))], {}],
    ['an unrecognised verdict after two completed rounds', [...TWO_ROUNDS, comment(review('Maybe'))], { fixes: 2 }],
    [
      'conflicting verdict declarations',
      [...TWO_ROUNDS, comment(review('Request changes', { before: '**Verdict: Approve** — first draft' }))],
      { fixes: 2 },
    ],
    [
      'a valid declaration followed by a malformed one',
      [...TWO_ROUNDS, comment(review('Maybe', { before: '**Verdict: Request changes** — draft' }))],
      { fixes: 2 },
    ],
  ])('returns history-ambiguous for %s, never refunding a counted round', (_label, comments, counts) => {
    expect(interpretReviewHistory(comments, { me: ME })).toMatchObject({ ...counts, stopReason: 'history-ambiguous' })
  })
})

describe('resolveReviewPr — a fork PR is not this branch’s PR', () => {
  it('ignores a fork on a same-named branch and returns the same-repository PR', async () => {
    const fake = fakePr({
      branchPrs: [
        { number: 999, state: 'OPEN', isCrossRepository: true },
        { number: 640, state: 'OPEN', isCrossRepository: false },
      ],
    })
    expect(await resolveReviewPr(CWD, null, deps(fake))).toBe(640)
  })

  it('returns null when the only open PR is a fork', async () => {
    const fake = fakePr({ branchPrs: [{ number: 999, state: 'OPEN', isCrossRepository: true }] })
    expect(await resolveReviewPr(CWD, null, deps(fake))).toBe(null)
  })

  it('does not treat a closed fork as this branch’s closed PR', async () => {
    const fake = fakePr({ branchPrs: [{ number: 999, state: 'CLOSED', isCrossRepository: true }] })
    expect(await resolveReviewPr(CWD, null, deps(fake))).toBe(null)
  })

  it('refuses a listing that omits the fork flag', async () => {
    const fake = fakePr({ branchPrs: [{ number: 640, state: 'OPEN' }] })
    await expect(resolveReviewPr(CWD, null, deps(fake))).rejects.toThrow(/invalid PR discovery response/)
  })

  it('does not treat a closed same-repository PR as the branch when a fork is open', async () => {
    const fake = fakePr({
      branchPrs: [
        { number: 999, state: 'OPEN', isCrossRepository: true },
        { number: 640, state: 'CLOSED', isCrossRepository: false },
      ],
    })
    await expect(resolveReviewPr(CWD, null, deps(fake))).rejects.toThrow(/closed PR/)
  })
})

describe('a posted review not yet recorded is counted once (#662)', () => {
  /** Baseline marker, then a review posted with no `record` yet. */
  async function postedUnrecorded(body = RED) {
    const fake = fakePr()
    await resumeReviewLoop(CWD, { pr: PR, gh: fake.gh })
    fake.post(body)
    const loop = await resumeReviewLoop(CWD, { pr: PR, gh: fake.gh })
    return { fake, loop }
  }

  it('grants the fix when resumed after the review and before record', async () => {
    const { fake, loop } = await postedUnrecorded()
    expect({ reviews: loop.reviews, fixes: loop.fixes, closed: loop.closed }).toEqual({
      reviews: 1,
      fixes: 0,
      closed: null,
    })
    const step = loop.record('red')
    expect(step).toEqual({ action: 'fix', reviews: 1, fixes: 1, remaining: 1 })
    await loop.persist(CWD)
    await expect(loop.assertFixAllowed(CWD, step)).resolves.toBe(step)
    expect(loop.closed).toBe(null)
    expect(await strict(fake)).toEqual({ reviews: 1, fixes: 1 })
  })

  it('counts the second posted review once, so the last fix round is not lost', async () => {
    const fake = fakePr()
    const first = await resumeReviewLoop(CWD, { pr: PR, gh: fake.gh })
    await fixed(first, fake, await reviewed(first, fake, 'red'))
    fake.post(RED)
    const loop = await resumeReviewLoop(CWD, { pr: PR, gh: fake.gh })
    const step = loop.record('red')
    expect(step).toEqual({ action: 'fix', reviews: 2, fixes: 2, remaining: 0 })
    await loop.persist(CWD)
    await expect(loop.assertFixAllowed(CWD, step)).resolves.toBe(step)
    expect(await strict(fake)).toEqual({ reviews: 2, fixes: 2 })
  })

  it('lands a posted green without spending an extra review', async () => {
    const { loop } = await postedUnrecorded(GREEN)
    expect(loop.record('green')).toEqual({ action: 'land', reviews: 1, fixes: 0 })
  })

  it('still increments when every posted review is already recorded', async () => {
    const fake = fakePr()
    const first = await resumeReviewLoop(CWD, { pr: PR, gh: fake.gh })
    await fixed(first, fake, await reviewed(first, fake, 'red'))
    const loop = await resumeReviewLoop(CWD, { pr: PR, gh: fake.gh })
    expect({ reviews: loop.reviews, fixes: loop.fixes }).toEqual({ reviews: 1, fixes: 1 })
    const step = await reviewed(loop, fake, 'red')
    expect(step).toEqual({ action: 'fix', reviews: 2, fixes: 2, remaining: 0 })
    await expect(loop.assertFixAllowed(CWD, step)).resolves.toBe(step)
  })

  it('fails closed when more than one review is posted after the last marker', async () => {
    const fake = fakePr()
    await resumeReviewLoop(CWD, { pr: PR, gh: fake.gh })
    fake.post(RED)
    fake.post(RED)
    expect(interpretReviewHistory(fake.pr.comments, { me: ME })).toEqual({
      reviews: 2,
      fixes: 0,
      stopReason: 'history-ambiguous',
    })
    const loop = await resumeReviewLoop(CWD, { pr: PR, gh: fake.gh })
    expect(loop.stopReason).toBe('history-ambiguous')
  })

  it('does not count a review by another account, or a forged marker, as the unrecorded review', async () => {
    const fake = fakePr()
    await resumeReviewLoop(CWD, { pr: PR, gh: fake.gh })
    fake.post(RED, 'attacker')
    fake.post(accounting(2, 2), 'attacker')
    const loop = await resumeReviewLoop(CWD, { pr: PR, gh: fake.gh })
    expect({ reviews: loop.reviews, fixes: loop.fixes, closed: loop.closed }).toEqual({
      reviews: 0,
      fixes: 0,
      closed: null,
    })
    fake.post(RED)
    const step = loop.record('red')
    expect(step).toEqual({ action: 'fix', reviews: 1, fixes: 1, remaining: 1 })
    await loop.persist(CWD)
    await expect(loop.assertFixAllowed(CWD, step)).resolves.toBe(step)
  })

  it('does not sticky-stop a granted fix whose receipt is not posted yet', async () => {
    const fake = fakePr()
    const { loop, step } = await allocate(fake, 2)
    await loop.assertFixAllowed(CWD, step)
    const resumed = await resumeReviewLoop(CWD, { pr: PR, gh: fake.gh })
    expect({ closed: resumed.closed, stopReason: resumed.stopReason, pendingFix: resumed.pendingFix }).toEqual({
      closed: null,
      stopReason: undefined,
      pendingFix: false,
    })
    expect(interpretReviewHistory(fake.pr.comments, { me: ME })).toEqual({ reviews: 2, fixes: 2 })
  })

  it('still stops when a red review follows the receipt of the exhausted allocation', async () => {
    const comments = [...TWO_ROUNDS, comment(RED)]
    expect(interpretReviewHistory(comments, { me: ME })).toEqual({
      reviews: 3,
      fixes: 2,
      stopReason: 'review-bound',
    })
    const resumed = await resumeReviewLoop(CWD, { pr: PR, gh: fakePr({ comments }).gh })
    expect(resumed.stopReason).toBe('review-bound')
  })
})

/** What `assertFixAllowed` posts before it returns a PR grant. */
const grant = (reviews, fixes, token = 'a'.repeat(16)) =>
  `<!-- omp-build:fix-grant reviews=${reviews} fixes=${fixes} token=${token} -->\nFix grant: round ${fixes} of 2 consumed.`

describe('a persisted fix allocation outlives the process that recorded it (#699)', () => {
  /** One-shot process: resume, the review is posted, record + persist, exit. */
  async function oneShot(fake, verdict = 'red') {
    const loop = await resumeReviewLoop(CWD, { pr: PR, gh: fake.gh })
    return { loop, step: await reviewed(loop, fake, verdict) }
  }
  const resume = (fake) => resumeReviewLoop(CWD, { pr: PR, gh: fake.gh })
  const bodies = (fake) => fake.pr.comments.map((entry) => entry.body)
  const gitOf = (fake) => ({ gh: fake.gh, git: fake.git })
  const REVIEWED_HEAD = '0123456789abcdef0123456789abcdef01234567'
  const ELSEWHERE = 'b'.repeat(40)

  it('grants a one-shot allocation to a resumed process exactly once, in any later process', async () => {
    const fake = fakePr()
    const { step: allocated } = await oneShot(fake)
    expect(allocated).toEqual({ action: 'fix', reviews: 1, fixes: 1, remaining: 1 })

    const resumed = await resume(fake)
    // The bare allocation is not a grant: nothing is live until it is claimed.
    expect(resumed.pendingFix).toBe(false)
    await expect(resumed.assertFixAllowed(CWD, allocated)).rejects.toThrow('no live unconsumed fix allocation')
    expect(resumed.persistedFix).toEqual({ reviews: 1, fixes: 1, remaining: 1 })

    const step = await resumed.claimPersistedFix(CWD, gitOf(fake))
    expect(step).toEqual({ action: 'fix', reviews: 1, fixes: 1, remaining: 1 })
    await expect(resumed.assertFixAllowed(CWD, step, gitOf(fake))).resolves.toBe(step)
    await expect(resumed.assertFixAllowed(CWD, step, gitOf(fake))).rejects.toThrow('no live unconsumed')
    await expect(resumed.claimPersistedFix(CWD, gitOf(fake))).rejects.toThrow('nothing to claim')

    // Consumed for everyone else: a third process sees nothing to claim, and no round was added.
    const third = await resume(fake)
    expect({ persistedFix: third.persistedFix, closed: third.closed }).toEqual({ persistedFix: null, closed: null })
    await expect(third.claimPersistedFix(CWD, gitOf(fake))).rejects.toThrow('nothing to claim')
    expect(await strict(fake)).toEqual({ reviews: 1, fixes: 1 })
    expect(bodies(fake).filter((body) => body.startsWith('<!-- omp-build:fix-grant'))).toHaveLength(1)
  })

  it('claims a ci-failed allocation the same way', async () => {
    const fake = fakePr()
    const first = await resume(fake)
    await reviewed(first, fake, 'green')
    const allocated = first.reopen('ci-failed')
    await first.persist(CWD)

    const resumed = await resume(fake)
    expect(resumed.persistedFix).toEqual({ reviews: 1, fixes: 1, remaining: 1, reason: 'ci-failed' })
    const step = await resumed.claimPersistedFix(CWD, gitOf(fake))
    expect(step).toEqual(allocated)
    await expect(resumed.assertFixAllowed(CWD, step, gitOf(fake))).resolves.toBe(step)

    // A CI fix posts no receipt, so the grant marker is the only thing that consumes it.
    const third = await resume(fake)
    expect(third.persistedFix).toBe(null)
    await expect(third.claimPersistedFix(CWD, gitOf(fake))).rejects.toThrow('nothing to claim')
    expect(bodies(fake).filter((body) => body.startsWith('<!-- omp-build:fix-grant'))).toHaveLength(1)
  })

  it('claims, once, an allocation a version without grant markers persisted', async () => {
    const fake = fakePr({ comments: [comment(RED), comment(accounting(1, 1))] })
    const resumed = await resume(fake)
    const step = await resumed.claimPersistedFix(CWD, gitOf(fake))
    await expect(resumed.assertFixAllowed(CWD, step, gitOf(fake))).resolves.toBe(step)
    expect((await resume(fake)).persistedFix).toBe(null)
  })

  it.each([
    ['a red review no marker allocated (history-ambiguous)', [comment(RED)], 'the loop is closed'],
    [
      'an allocation a grant marker already covers',
      [comment(RED), comment(accounting(1, 1)), comment(grant(1, 1))],
      'nothing to claim',
    ],
    [
      'an allocation whose fix posted its receipt',
      [comment(RED), comment(accounting(1, 1)), comment(RECEIPT)],
      'nothing to claim',
    ],
    [
      'an allocation a later review follows',
      [comment(RED), comment(accounting(1, 1)), comment(RED)],
      'nothing to claim',
    ],
    [
      'a later review a marker already recorded',
      [comment(RED), comment(accounting(1, 1)), comment(GREEN), comment(accounting(2, 1))],
      'nothing to claim',
    ],
    [
      'two posted reviews of which the marker counts one',
      [comment(RED), comment(RED), comment(accounting(1, 1))],
      'nothing to claim',
    ],
    [
      'an allocation another account wrote',
      [comment(accounting(0, 0)), comment(RED), comment(accounting(1, 1), 'omp-bot-2')],
      'nothing to claim',
    ],
    ['a sticky stop', [comment(RED), comment(accounting(1, 1, 'review-bound'))], 'the loop is closed'],
  ])('claims nothing for %s, and writes nothing', async (_label, comments, message) => {
    const fake = fakePr({ comments })
    const before = bodies(fake)
    const resumed = await resume(fake)
    expect(resumed.persistedFix).toBe(null)
    await expect(resumed.claimPersistedFix(CWD, gitOf(fake))).rejects.toThrow(message)
    expect(bodies(fake)).toEqual(before)
    expect(resumed.pendingFix).toBe(false)
  })

  it('does not let another account’s grant marker consume the allocation', async () => {
    const fake = fakePr({ comments: [comment(RED), comment(accounting(1, 1)), comment(grant(1, 1), 'omp-bot-2')] })
    const resumed = await resume(fake)
    expect(resumed.persistedFix).toEqual({ reviews: 1, fixes: 1, remaining: 1 })
  })

  describe('the head the review covers', () => {
    it('refuses a claim when the PR head moved, the review names none, or the checkout differs; writes nothing', async () => {
      const moved = fakePr()
      await oneShot(moved)
      moved.pr.headRefOid = ELSEWHERE
      const headless = RED.replace(/^<!-- omp-build:review-head.*\n/m, '')
      const noHead = fakePr({ comments: [comment(headless), comment(accounting(1, 1))] })
      const elsewhere = fakePr()
      await oneShot(elsewhere)
      elsewhere.pr.localHead = ELSEWHERE

      const errors = []
      for (const fake of [moved, noHead, elsewhere]) {
        const before = bodies(fake)
        const resumed = await resume(fake)
        errors.push((await refusal(resumed.claimPersistedFix(CWD, gitOf(fake)))).message)
        expect(bodies(fake)).toEqual(before)
        expect(resumed.closed).toBe(null)
        expect(resumed.pendingFix).toBe(false)
      }
      expect(errors[0]).toContain('head-moved')
      expect(errors[1]).toContain('no-review-head')
      expect(errors[2]).toContain('this checkout is at')

      // The refusal is recoverable: once the PR is at the reviewed head again, the claim goes through.
      moved.pr.headRefOid = REVIEWED_HEAD
      const resumed = await resume(moved)
      await expect(resumed.claimPersistedFix(CWD, gitOf(moved))).resolves.toMatchObject({ action: 'fix' })
    })

    it('refuses the grant when the head moves after the claim, keeping the step claimed', async () => {
      const fake = fakePr()
      await oneShot(fake)
      const resumed = await resume(fake)
      const step = await resumed.claimPersistedFix(CWD, gitOf(fake))
      fake.pr.headRefOid = ELSEWHERE
      const before = bodies(fake)
      const error = await refusal(resumed.assertFixAllowed(CWD, step, gitOf(fake)))
      expect(error.message).toContain('head-moved')
      expect(error.stop).toBeUndefined()
      expect(bodies(fake)).toEqual(before)
      expect(resumed.pendingFix).toBe(true)
      fake.pr.headRefOid = REVIEWED_HEAD
      await expect(resumed.assertFixAllowed(CWD, step, gitOf(fake))).resolves.toBe(step)
    })

    it('refuses the grant when the checkout leaves the reviewed head after the claim', async () => {
      const fake = fakePr()
      await oneShot(fake)
      const resumed = await resume(fake)
      const step = await resumed.claimPersistedFix(CWD, gitOf(fake))
      fake.pr.localHead = ELSEWHERE
      const before = bodies(fake)
      await expect(resumed.assertFixAllowed(CWD, step, gitOf(fake))).rejects.toThrow('this checkout is at')
      expect(bodies(fake)).toEqual(before)
      fake.pr.localHead = REVIEWED_HEAD
      await expect(resumed.assertFixAllowed(CWD, step, gitOf(fake))).resolves.toBe(step)
    })
  })

  describe('recovery never records the posted review a second time', () => {
    it('refuses record while the persisted allocation is unclaimed and while the claim awaits its grant', async () => {
      const fake = fakePr()
      await oneShot(fake)
      const resumed = await resume(fake)
      const before = bodies(fake)

      expect(() => resumed.record('red')).toThrow('claimPersistedFix')
      expect(bodies(fake)).toEqual(before)
      expect({ reviews: resumed.reviews, fixes: resumed.fixes }).toEqual({ reviews: 1, fixes: 1 })

      const step = await resumed.claimPersistedFix(CWD, gitOf(fake))
      expect(() => resumed.record('red')).toThrow('awaiting its grant')
      expect(bodies(fake)).toEqual(before)
      await expect(resumed.assertFixAllowed(CWD, step, gitOf(fake))).resolves.toBe(step)

      // One posted review, one review record, no stop: the history never diverged.
      expect(bodies(fake).filter((body) => body.startsWith('<!-- omp-build:code-review -->'))).toHaveLength(1)
      expect(await strict(fake)).toEqual({ reviews: 1, fixes: 1 })
    })

    it('keeps the guard while the allocation is still open', async () => {
      const fake = fakePr()
      await oneShot(fake)
      const resumed = await resume(fake)
      await expect(resumed.refreshPersistedFix(CWD)).resolves.toEqual({ reviews: 1, fixes: 1, remaining: 1 })
      expect(() => resumed.record('red')).toThrow('claimPersistedFix')
    })

    it('never lifts the guard on a granted allocation without a newer review, so record cannot replay it', async () => {
      const fake = fakePr()
      await oneShot(fake)
      const [a, b] = [await resume(fake), await resume(fake)]
      const step = await b.claimPersistedFix(CWD, gitOf(fake))
      await b.assertFixAllowed(CWD, step, gitOf(fake))
      const before = bodies(fake)

      // A refresh that cannot lift says so (null always means "record now"); nothing is written.
      await expect(a.refreshPersistedFix(CWD)).rejects.toThrow('no newer review exists')
      expect(() => a.record('red')).toThrow('post a newer review')
      await expect(a.claimPersistedFix(CWD, gitOf(fake))).rejects.toThrow('nothing to claim')
      expect(bodies(fake)).toEqual(before)

      // The newer review is what makes record legitimate again, counted once.
      fake.post(RED)
      await expect(a.refreshPersistedFix(CWD)).resolves.toBe(null)
      expect(a.record('red')).toEqual({ action: 'fix', reviews: 2, fixes: 2, remaining: 0 })
    })

    it('guards a fresh resume onto a granted allocation whose receipt was never posted', async () => {
      const fake = fakePr()
      await oneShot(fake)
      const grantor = await resume(fake)
      const step = await grantor.claimPersistedFix(CWD, gitOf(fake))
      await grantor.assertFixAllowed(CWD, step, gitOf(fake))

      // The grantor crashed mid-fix: a new process resumes onto the grant marker alone.
      const resumed = await resume(fake)
      const before = bodies(fake)
      expect(resumed.persistedFix).toBe(null)
      await expect(resumed.refreshPersistedFix(CWD)).rejects.toThrow('no newer review exists')
      expect(() => resumed.record('red')).toThrow('post a newer review')
      await expect(resumed.claimPersistedFix(CWD, gitOf(fake))).rejects.toThrow('nothing to claim')
      expect(bodies(fake)).toEqual(before)

      // The re-review is what makes record legitimate again, counted once.
      fake.post(RED)
      await expect(resumed.refreshPersistedFix(CWD)).resolves.toBe(null)
      const next = resumed.record('red')
      await resumed.persist(CWD)
      expect(next).toEqual({ action: 'fix', reviews: 2, fixes: 2, remaining: 0 })
      expect(bodies(fake).filter((body) => body.startsWith('<!-- omp-build:code-review -->'))).toHaveLength(2)
    })

    it('keeps the guard when a step this process held was granted by another, so record cannot replay it', async () => {
      const fake = fakePr()
      const { loop, step } = await oneShot(fake)
      const other = await resume(fake)
      const claimed = await other.claimPersistedFix(CWD, gitOf(fake))
      await other.assertFixAllowed(CWD, claimed, gitOf(fake))

      await expect(loop.assertFixAllowed(CWD, step)).rejects.toThrow('already granted')
      expect(() => loop.record('red')).toThrow('post a newer review')
      fake.post(RED)
      await expect(loop.refreshPersistedFix(CWD)).resolves.toBe(null)
      expect(loop.record('red')).toMatchObject({ action: 'fix', fixes: 2 })
    })

    it('lets a claimed step whose head moved recover in the same process through a newer review', async () => {
      const fake = fakePr()
      await oneShot(fake)
      const resumed = await resume(fake)
      const step = await resumed.claimPersistedFix(CWD, gitOf(fake))
      fake.pr.headRefOid = ELSEWHERE
      await expect(resumed.assertFixAllowed(CWD, step, gitOf(fake))).rejects.toThrow('head-moved')
      expect(() => resumed.record('red')).toThrow('refreshPersistedFix')
      await expect(resumed.refreshPersistedFix(CWD)).rejects.toThrow('awaiting its grant')
      expect(resumed.pendingFix).toBe(true)

      // dev-review re-reviewed the moved head: the claim was never granted, so it is dropped.
      fake.post(RED)
      await expect(resumed.refreshPersistedFix(CWD)).resolves.toBe(null)
      expect(resumed.pendingFix).toBe(false)
      const next = resumed.record('red')
      await resumed.persist(CWD)
      expect(next).toEqual({ action: 'fix', reviews: 2, fixes: 2, remaining: 0 })
      await expect(resumed.assertFixAllowed(CWD, next, gitOf(fake))).resolves.toBe(next)
      expect(await strict(fake)).toEqual({ reviews: 2, fixes: 2 })
    })

    it('leaves no dead end after a grant that was written but lost or unconfirmed', async () => {
      const lost = fakePr()
      await oneShot(lost)
      const [a, b] = [await resume(lost), await resume(lost)]
      const stepA = await a.claimPersistedFix(CWD, gitOf(lost))
      const stepB = await b.claimPersistedFix(CWD, gitOf(lost))
      await b.assertFixAllowed(CWD, stepB, gitOf(lost))
      await expect(a.assertFixAllowed(CWD, stepA, gitOf(lost))).rejects.toThrow()
      expect(a.pendingFix).toBe(false)
      expect(() => a.record('red')).toThrow('post a newer review')

      lost.post(RED)
      await expect(a.refreshPersistedFix(CWD)).resolves.toBe(null)
      expect(a.record('red')).toMatchObject({ action: 'fix', fixes: 2 })
    })

    it('keeps the guard on a grant it could not confirm, and lifts it on a newer review', async () => {
      const fake = fakePr()
      await oneShot(fake)
      const resumed = await resume(fake)
      const step = await resumed.claimPersistedFix(CWD, gitOf(fake))
      let posted = false
      const gh = async (cwd, args) => {
        if (posted && args[0] === 'api' && args.includes('--paginate')) throw new Error('gh: timeout')
        const out = await fake.gh(cwd, args)
        if (args[1] === 'comment') posted = true
        return out
      }
      await expect(resumed.assertFixAllowed(CWD, step, { gh, git: fake.git })).rejects.toThrow('consumed')
      expect(() => resumed.record('red')).toThrow('post a newer review')
      await expect(resumed.claimPersistedFix(CWD, gitOf(fake))).rejects.toThrow('nothing to claim')

      fake.post(RED)
      await expect(resumed.refreshPersistedFix(CWD)).resolves.toBe(null)
      expect(resumed.record('red')).toMatchObject({ action: 'fix', fixes: 2 })
    })
  })

  describe('single use is durable', () => {
    it('grants two processes that claimed the same allocation at most once', async () => {
      const fake = fakePr()
      await oneShot(fake)
      const [a, b] = [await resume(fake), await resume(fake)]
      const stepA = await a.claimPersistedFix(CWD, gitOf(fake))
      const stepB = await b.claimPersistedFix(CWD, gitOf(fake))
      const outcomes = await Promise.allSettled([
        a.assertFixAllowed(CWD, stepA, gitOf(fake)),
        b.assertFixAllowed(CWD, stepB, gitOf(fake)),
      ])
      expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected'])
    })

    it('gives the step back when the grant marker cannot be written, and grants it on retry', async () => {
      const fake = fakePr()
      await oneShot(fake)
      const resumed = await resume(fake)
      const step = await resumed.claimPersistedFix(CWD, gitOf(fake))
      let failing = true
      const gh = async (cwd, args) => {
        if (failing && args[1] === 'comment') throw new Error('gh: 502')
        return fake.gh(cwd, args)
      }
      const before = bodies(fake)
      await expect(resumed.assertFixAllowed(CWD, step, { gh, git: fake.git })).rejects.toThrow('502')
      expect(bodies(fake)).toEqual(before)
      expect(resumed.pendingFix).toBe(true)
      failing = false
      await expect(resumed.assertFixAllowed(CWD, step, { gh, git: fake.git })).resolves.toBe(step)
    })

    it('consumes the allocation, never doubles it, when the written grant cannot be confirmed', async () => {
      const fake = fakePr()
      await oneShot(fake)
      const resumed = await resume(fake)
      const step = await resumed.claimPersistedFix(CWD, gitOf(fake))
      let posted = false
      const gh = async (cwd, args) => {
        if (posted && args[0] === 'api' && args.includes('--paginate')) throw new Error('gh: timeout')
        const out = await fake.gh(cwd, args)
        if (args[1] === 'comment') posted = true
        return out
      }
      const error = await refusal(resumed.assertFixAllowed(CWD, step, { gh, git: fake.git }))
      expect(error.message).toContain('consumed')
      expect(resumed.pendingFix).toBe(false)
      expect((await resume(fake)).persistedFix).toBe(null)
      await expect(resumed.assertFixAllowed(CWD, step, gitOf(fake))).rejects.toThrow('no live unconsumed')
    })
  })

  describe('two processes that both read the allocation as ungranted', () => {
    const isGrantWrite = (args) => args[1] === 'comment' && String(args[4]).startsWith('<!-- omp-build:fix-grant')
    /** The grant marker write of `fake`, held until `release()`; `attempted` settles once it is reached. */
    function gated(fake) {
      let release = () => {}
      let reached = () => {}
      const hold = new Promise((resolve) => {
        release = resolve
      })
      const attempted = new Promise((resolve) => {
        reached = resolve
      })
      const gh = async (cwd, args) => {
        if (isGrantWrite(args)) {
          reached()
          await hold
        }
        return fake.gh(cwd, args)
      }
      return { gh, release, attempted }
    }

    it('grants the earliest marker, though the loser’s marker lands after the winner finished', async () => {
      const fake = fakePr()
      await oneShot(fake)
      const [a, b] = [await resume(fake), await resume(fake)]
      const stepA = await a.claimPersistedFix(CWD, gitOf(fake))
      const stepB = await b.claimPersistedFix(CWD, gitOf(fake))
      const held = gated(fake)
      const outcomeB = refusal(b.assertFixAllowed(CWD, stepB, { gh: held.gh, git: fake.git }))
      await held.attempted
      await expect(a.assertFixAllowed(CWD, stepA, gitOf(fake))).resolves.toBe(stepA)
      held.release()

      const error = await outcomeB
      expect(error.message).toContain('another process')
      expect(bodies(fake).filter((body) => body.startsWith('<!-- omp-build:fix-grant'))).toHaveLength(2)
      expect(b.pendingFix).toBe(false)
      // The loser can neither record the review again nor grant itself: only a newer review moves it on.
      expect(() => b.record('red')).toThrow('post a newer review')
      fake.post(RED)
      await expect(b.refreshPersistedFix(CWD)).resolves.toBe(null)
    })

    it('refuses a process that resumed before another was granted, without writing', async () => {
      const fake = fakePr()
      await oneShot(fake)
      const [a, b] = [await resume(fake), await resume(fake)]
      const step = await a.claimPersistedFix(CWD, gitOf(fake))
      await a.assertFixAllowed(CWD, step, gitOf(fake))
      const before = bodies(fake)

      await expect(b.claimPersistedFix(CWD, gitOf(fake))).rejects.toThrow('no longer open')
      expect(() => b.record('red')).toThrow('post a newer review')
      expect(bodies(fake)).toEqual(before)
    })

    it('refuses the grant of a claim another process was granted meanwhile, writing no second marker', async () => {
      const fake = fakePr()
      await oneShot(fake)
      const [a, b] = [await resume(fake), await resume(fake)]
      const stepB = await b.claimPersistedFix(CWD, gitOf(fake))
      const stepA = await a.claimPersistedFix(CWD, gitOf(fake))
      await a.assertFixAllowed(CWD, stepA, gitOf(fake))
      const before = bodies(fake)

      await expect(b.assertFixAllowed(CWD, stepB, gitOf(fake))).rejects.toThrow('already granted')
      expect(bodies(fake)).toEqual(before)
      expect(b.pendingFix).toBe(false)
      expect(() => b.record('red')).toThrow('post a newer review')
    })
  })

  describe('grant markers in the history', () => {
    const history = (...bodies) => bodies.map((body) => comment(body))
    const [A, B, C] = ['a', 'b', 'c'].map((char) => char.repeat(16))

    it('takes the earliest token of an allocation, and never reopens an allocation a later grant covered', () => {
      const twice = analyzeReviewHistory(history(RED, accounting(1, 1), grant(1, 1, A), grant(1, 1, B)), { me: ME })
      expect(twice.grantTokens.get(1)).toBe(A)

      // A loser’s late marker for the first allocation does not reopen the second one.
      const late = analyzeReviewHistory(
        history(RED, accounting(1, 1), grant(1, 1, A), RECEIPT, RED, accounting(2, 2), grant(2, 2, B), grant(1, 1, C)),
        { me: ME },
      )
      expect(late.grantedFixes).toBe(2)
      expect(late.openAllocation).toBe(false)
    })
  })

  describe('what a resumed loop sees change under it', () => {
    it.each(['claimPersistedFix', 'refreshPersistedFix'])(
      'enforces a stop posted after the resume, at %s',
      async (method) => {
        const fake = fakePr()
        await oneShot(fake)
        const resumed = await resume(fake)
        fake.pr.labels.add('reviewed')
        fake.pr.autoMerge = { mergeMethod: 'MERGE' }
        fake.post(accounting(1, 1, 'review-bound'))

        const error = await refusal(resumed[method](CWD, gitOf(fake)))
        expect(error.message).toContain('stopped (review-bound)')
        expect(error.stop).toBeDefined()
        expect(fake.pr.labels.has('reviewed')).toBe(false)
        expect(fake.pr.autoMerge).toBe(null)
        expect({ closed: resumed.closed, persistedFix: resumed.persistedFix }).toEqual({
          closed: 'stop',
          persistedFix: null,
        })
        await expect(resumed.claimPersistedFix(CWD, gitOf(fake))).rejects.toThrow('the loop is closed')
      },
    )

    it('refreshes a loop with no allocation to null, and record still works', async () => {
      const fake = fakePr()
      const loop = await resume(fake)
      await expect(loop.refreshPersistedFix(CWD)).resolves.toBe(null)
      fake.post(RED)
      expect(loop.record('red')).toMatchObject({ action: 'fix', reviews: 1, fixes: 1 })
    })

    it('refuses a second refresh once a stop is enforced, posting no further stop', async () => {
      const fake = fakePr()
      await oneShot(fake)
      const resumed = await resume(fake)
      fake.post(accounting(1, 1, 'review-bound'))
      await expect(resumed.refreshPersistedFix(CWD)).rejects.toThrow('stopped (review-bound)')
      const afterStop = bodies(fake).length
      await expect(resumed.refreshPersistedFix(CWD)).rejects.toThrow('loop is stopped')
      expect(bodies(fake)).toHaveLength(afterStop)
    })

    it('refuses a claim when gh answers as another account after the resume, writing nothing', async () => {
      const fake = fakePr()
      await oneShot(fake)
      const resumed = await resume(fake)
      const before = bodies(fake)
      fake.pr.me = 'omp-bot-2'
      await expect(resumed.claimPersistedFix(CWD, gitOf(fake))).rejects.toThrow('another account')
      expect(bodies(fake)).toEqual(before)
      expect(resumed.pendingFix).toBe(false)
    })

    it('refuses a refresh when the PR history moved since the resume', async () => {
      const fake = fakePr()
      await oneShot(fake)
      const resumed = await resume(fake)
      fake.post(accounting(2, 2))
      await expect(resumed.refreshPersistedFix(CWD)).rejects.toThrow('moved since this loop resumed')
      expect(() => resumed.record('red')).toThrow('claimPersistedFix')
    })

    it('does not lift the guard on counts another process has since moved', async () => {
      const fake = fakePr()
      await oneShot(fake)
      const [a, b] = [await resume(fake), await resume(fake)]
      const step = await b.claimPersistedFix(CWD, gitOf(fake))
      await b.assertFixAllowed(CWD, step, gitOf(fake))
      fake.post(RECEIPT)
      fake.post(RED)
      const next = b.record('red')
      await b.persist(CWD)
      await b.assertFixAllowed(CWD, next)

      await expect(a.refreshPersistedFix(CWD)).rejects.toThrow('moved since this loop resumed')
      expect(() => a.record('red')).toThrow('claimPersistedFix')
    })

    it('refuses a claim after another process recorded and persisted a newer round', async () => {
      const fake = fakePr()
      await oneShot(fake)
      const [a, b] = [await resume(fake), await resume(fake)]
      const step = await b.claimPersistedFix(CWD, gitOf(fake))
      await b.assertFixAllowed(CWD, step, gitOf(fake))
      fake.post(RECEIPT)
      fake.post(RED)
      b.record('red')
      await b.persist(CWD)

      await expect(a.claimPersistedFix(CWD, gitOf(fake))).rejects.toThrow('moved since this loop resumed')
      expect(() => a.record('red')).toThrow('claimPersistedFix')
    })

    it('keeps the guard when a claim finds the allocation granted and a green recorded', async () => {
      const fake = fakePr()
      await oneShot(fake)
      const [a, b] = [await resume(fake), await resume(fake)]
      const step = await b.claimPersistedFix(CWD, gitOf(fake))
      await b.assertFixAllowed(CWD, step, gitOf(fake))
      fake.post(GREEN)
      b.record('green')
      await b.persist(CWD)

      await expect(a.claimPersistedFix(CWD, gitOf(fake))).rejects.toThrow()
      expect(() => a.record('red')).toThrow('post a newer review')
    })

    it('grants one of two overlapping claims on the same loop', async () => {
      const fake = fakePr()
      await oneShot(fake)
      const resumed = await resume(fake)
      const outcomes = await Promise.allSettled([
        resumed.claimPersistedFix(CWD, gitOf(fake)),
        resumed.claimPersistedFix(CWD, gitOf(fake)),
      ])
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    })

    it('lets a claimed process carry on after its grant: fix, re-review, record', async () => {
      const fake = fakePr()
      await oneShot(fake)
      const resumed = await resume(fake)
      const step = await resumed.claimPersistedFix(CWD, gitOf(fake))
      await resumed.assertFixAllowed(CWD, step, gitOf(fake))
      fake.post(RECEIPT)
      fake.post(RED)

      const next = resumed.record('red')
      expect(next).toEqual({ action: 'fix', reviews: 2, fixes: 2, remaining: 0 })
      await resumed.persist(CWD)
      await expect(resumed.assertFixAllowed(CWD, next)).resolves.toBe(next)
      expect(await strict(fake)).toEqual({ reviews: 2, fixes: 2 })
    })

    describe('a grant marker that cannot be written', () => {
      const isGrantWrite = (args) => args[1] === 'comment' && String(args[4]).startsWith('<!-- omp-build:fix-grant')

      it('is not given back once the loop closed meanwhile', async () => {
        const fake = fakePr()
        const { loop, step } = await oneShot(fake)
        const gh = async (cwd, args) => {
          if (!isGrantWrite(args)) return fake.gh(cwd, args)
          fake.post(GREEN)
          loop.record('green')
          throw new Error('gh: 502')
        }
        await expect(loop.assertFixAllowed(CWD, step, { gh, git: fake.git })).rejects.toThrow('502')
        expect({ closed: loop.closed, pendingFix: loop.pendingFix }).toEqual({ closed: 'land', pendingFix: false })
      })

      it('does not overwrite a newer allocation the loop made meanwhile', async () => {
        const fake = fakePr()
        const { loop, step } = await oneShot(fake)
        let newer = null
        const gh = async (cwd, args) => {
          if (!isGrantWrite(args)) return fake.gh(cwd, args)
          fake.post(RED)
          newer = loop.record('red')
          throw new Error('gh: 502')
        }
        await expect(loop.assertFixAllowed(CWD, step, { gh, git: fake.git })).rejects.toThrow('502')
        expect(newer).toMatchObject({ action: 'fix', fixes: 2 })
        await loop.persist(CWD)
        await expect(loop.assertFixAllowed(CWD, newer)).resolves.toBe(newer)
      })
    })
  })
})
