import { describe, expect, it } from 'vitest'
import {
  createReviewLoop,
  interpretReviewHistory,
  landPr,
  MAX_FIX_ROUNDS,
  openPr,
  parseReviewRounds,
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
  /** Open PR numbers for the branch, a raw answer, or the Error the lookup throws. */
  open = [PR],
} = {}) {
  const pr = { me, comments: [...comments], labels: new Set(labels), autoMerge, state, branch, open }
  const n = String(PR)
  const calls = []
  const gh = async (_cwd, args) => {
    calls.push(args)
    if (same(args, IDENTITY)) return `${pr.me}\n`
    if (same(args, ['pr', 'list', '--head', pr.branch, '--state', 'open', '--json', 'number'])) {
      if (pr.open instanceof Error) throw pr.open
      return typeof pr.open === 'string' ? pr.open : JSON.stringify(pr.open.map((number) => ({ number })))
    }
    if (args.length === 5 && same(args.slice(0, 4), ['pr', 'view', n, '--json'])) {
      /** @type {Record<string, unknown>} */
      const view = {}
      for (const field of args[4].split(',')) {
        if (field === 'comments') view.comments = pr.comments
        else if (field === 'labels') view.labels = [...pr.labels].map((name) => ({ name }))
        else if (field === 'autoMergeRequest') view.autoMergeRequest = pr.autoMerge
        else if (field === 'state') view.state = pr.state
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
    throw new Error(`unexpected gh call: ${args.join(' ')}`)
  }
  const git = async (_cwd, args) => {
    calls.push(['git', ...args])
    if (same(args, ['branch', '--show-current'])) return pr.branch
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
const LOOKUP = ['pr', 'list', '--head', INPUT.branch, '--base', INPUT.base, '--state', 'open', '--json', 'number']

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
    // Re-running mode 2 after a crash must not put a second PR on one branch.
    const { gh, calls } = mockGh({ list: JSON.stringify([{ number: 400 }]) })
    expect(await openPr('/tmp/wt', INPUT, { gh })).toEqual({ number: 400, status: 'existing' })
    expect(calls).toEqual([LOOKUP])
  })

  it('picks the oldest when the head somehow carries two open PRs', async () => {
    const { gh, calls } = mockGh({ list: JSON.stringify([{ number: 640 }, { number: 400 }]) })
    expect(await openPr('/tmp/wt', INPUT, { gh })).toEqual({ number: 400, status: 'existing' })
    expect(calls).toEqual([LOOKUP])
  })

  it('re-reads on GitHub\u2019s own 422, classified on the exit payload', async () => {
    // The realistic client failure: `gh` exits non-zero with the API's JSON body.
    const { gh, calls } = mockGh({
      list: ['[]', JSON.stringify([{ number: 402 }])],
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
      list: ['[]', JSON.stringify([{ number: 403 }])],
      createThrows:
        'gh api --method POST … -f title=fix: a pull request already exists on re-entry failed (1): HTTP 403 — resource not accessible by integration',
    })
    await expect(openPr('/tmp/wt', input, { gh })).rejects.toThrow(/resource not accessible/)
    expect(calls.filter((args) => args[0] === 'pr')).toEqual([LOOKUP])
  })

  it('does not read the race out of the body it was handed', async () => {
    const body = 'Re-entry is safe: a pull request already exists for this head, and openPr reuses it.'
    const { gh, calls } = mockGh({
      list: ['[]', JSON.stringify([{ number: 404 }])],
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
      list: ['[]', JSON.stringify([{ number: 401 }])],
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
  const LIST = ['pr', 'list', '--head', BRANCH, '--state', 'open', '--json', 'number']

  it.each([512, '512'])('takes an explicit PR %o without asking git or gh', async (explicit) => {
    const fake = fakePr()
    expect(await resolveReviewPr(CWD, explicit, deps(fake))).toBe(512)
    expect(fake.calls).toEqual([])
  })

  it.each([null, undefined, ''])('discovers the open PR of the current branch for %o', async (explicit) => {
    const fake = fakePr({ open: [640] })
    expect(await resolveReviewPr(CWD, explicit, deps(fake))).toBe(640)
    // Any open PR for this head, whatever its base: a `--base` would miss one opened against another base.
    expect(fake.calls).toEqual([['git', 'branch', '--show-current'], LIST])
  })

  it('answers null — a genuinely local review — only when the branch has no open PR', async () => {
    expect(await resolveReviewPr(CWD, null, deps(fakePr({ open: [] })))).toBe(null)
  })

  it.each([
    ['the lookup fails', { open: new Error('HTTP 502') }],
    ['the lookup is not JSON', { open: 'no pull requests match your search' }],
    ['the lookup is not an array', { open: '{"number":512}' }],
    ['an entry carries no PR number', { open: '[{"title":"feat: sinks"}]' }],
    ['two PRs are open for the branch', { open: [512, 640] }],
    ['HEAD is detached', { branch: '' }],
  ])('refuses when %s — a failed lookup is not "no PR"', async (_label, options) => {
    await expect(resolveReviewPr(CWD, null, deps(fakePr(options)))).rejects.toThrow()
  })

  it.each([0, -3, 'abc', 1.5])('refuses an explicit %o instead of discovering some other PR', async (explicit) => {
    const fake = fakePr()
    await expect(resolveReviewPr(CWD, explicit, deps(fake))).rejects.toThrow()
    expect(fake.calls).toEqual([])
  })
})

describe('assertFixAllowed on a PR-less loop — proves there is no PR first', () => {
  it('grants the live allocation once when the branch has no open PR', async () => {
    const fake = fakePr({ open: [] })
    const loop = createReviewLoop()
    const step = loop.record('red')
    await expect(loop.assertFixAllowed(CWD, step, deps(fake))).resolves.toBe(step)
    await expect(loop.assertFixAllowed(CWD, step, deps(fake))).rejects.toThrow()
  })

  it('runs the second local allocation at fixes=2 once; the third red stops', async () => {
    const fake = fakePr({ open: [] })
    const loop = createReviewLoop()
    await loop.assertFixAllowed(CWD, loop.record('red'), deps(fake))
    const second = loop.record('red')
    expect(second).toEqual({ action: 'fix', reviews: 2, fixes: 2, remaining: 0 })
    await expect(loop.assertFixAllowed(CWD, second, deps(fake))).resolves.toBe(second)
    await expect(loop.assertFixAllowed(CWD, second, deps(fake))).rejects.toThrow()
    expect(loop.record('red').action).toBe('stop')
    await expect(loop.assertFixAllowed(CWD, second, deps(fake))).rejects.toThrow()
  })

  it('refuses a copy of the live step, or a non-fix step, without consuming the grant', async () => {
    const fake = fakePr({ open: [] })
    const loop = createReviewLoop()
    const step = loop.record('red')
    await expect(loop.assertFixAllowed(CWD, { ...step }, deps(fake))).rejects.toThrow()
    await expect(loop.assertFixAllowed(CWD, { action: 'land', reviews: 1, fixes: 1 }, deps(fake))).rejects.toThrow()
    await expect(loop.assertFixAllowed(CWD, step, deps(fake))).resolves.toBe(step)
  })

  it('refuses when the branch already has an open PR: that PR must be resumed, not bypassed', async () => {
    const fake = fakePr({ open: [PR], comments: [...TWO_ROUNDS, comment(RED)] })
    const loop = createReviewLoop()
    const step = loop.record('red')
    await expect(loop.assertFixAllowed(CWD, step, deps(fake))).rejects.toThrow()
    expect(fake.calls).toContainEqual(['pr', 'list', '--head', BRANCH, '--state', 'open', '--json', 'number'])
    expect(fake.pr.comments).toHaveLength(TWO_ROUNDS.length + 1)
    // The way in is the PR loop, and that PR is stopped.
    expect((await resumeReviewLoop(CWD, { pr: PR, gh: fake.gh })).closed).toBe('stop')
  })

  it.each([
    ['the lookup fails', { open: new Error('HTTP 502') }],
    ['two PRs are open for the branch', { open: [512, 640] }],
    ['HEAD is detached', { branch: '' }],
  ])('refuses when %s: a failed lookup never proves a local review', async (_label, options) => {
    const loop = createReviewLoop()
    const step = loop.record('red')
    await expect(loop.assertFixAllowed(CWD, step, deps(fakePr(options)))).rejects.toThrow()
  })

  it('grants overlapping calls for one step at most once', async () => {
    const fake = fakePr({ open: [] })
    const loop = createReviewLoop()
    const step = loop.record('red')
    const outcomes = await Promise.allSettled([
      loop.assertFixAllowed(CWD, step, deps(fake)),
      loop.assertFixAllowed(CWD, step, deps(fake)),
    ])
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected'])
  })

  it('sends a ci-failed round through the same guard', async () => {
    const loop = createReviewLoop()
    loop.record('green')
    const step = loop.reopen('ci-failed')
    await expect(loop.assertFixAllowed(CWD, step, deps(fakePr({ open: [] })))).resolves.toBe(step)
  })
})

describe('assertFixAllowed on a PR loop — fresh history at the fix sink', () => {
  it('grants the first persisted red allocation once, and changes nothing on the PR', async () => {
    const fake = fakePr({ labels: ['size:F-lite'] })
    const { loop, step } = await allocate(fake, 1)
    expect(step).toEqual({ action: 'fix', reviews: 1, fixes: 1, remaining: 1 })
    await expect(loop.assertFixAllowed(CWD, step)).resolves.toBe(step)
    await expect(loop.assertFixAllowed(CWD, step)).rejects.toThrow()
    expect(loop.closed).toBe(null)
    expect([...fake.pr.labels]).toEqual(['size:F-lite'])
    expect(await strict(fake)).toEqual({ reviews: 1, fixes: 1 })
  })

  it('grants the live second red at fixes=2 once, while the same history resumed stays stopped', async () => {
    const fake = fakePr()
    const { loop, step } = await allocate(fake, 2)
    expect(step).toEqual({ action: 'fix', reviews: 2, fixes: 2, remaining: 0 })

    const resumed = await resumeReviewLoop(CWD, { pr: PR, gh: fake.gh })
    expect({ closed: resumed.closed, stopReason: resumed.stopReason, pendingFix: resumed.pendingFix }).toEqual({
      closed: 'stop',
      stopReason: 'review-bound',
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

  it('never replays an earlier allocation on resume; a newly posted red allocates the remaining round', async () => {
    // Counter persisted, then the process died before the fix: that allocation is spent.
    const fake = fakePr({ comments: [comment(RED), comment(accounting(1, 1))] })
    const loop = await resumeReviewLoop(CWD, { pr: PR, gh: fake.gh })
    expect({ reviews: loop.reviews, fixes: loop.fixes, pendingFix: loop.pendingFix }).toEqual({
      reviews: 1,
      fixes: 1,
      pendingFix: false,
    })
    await expect(loop.assertFixAllowed(CWD, { action: 'fix', reviews: 1, fixes: 1, remaining: 1 })).rejects.toThrow()
    const step = await reviewed(loop, fake, 'red')
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

  it.each([
    [
      'another session published an explicit stop',
      (fake) => fake.post(accounting(1, 1, 'review-bound')),
      'review-bound',
    ],
    [
      'receipts the loop never allocated make the history ambiguous',
      (fake) => {
        fake.post(RECEIPT)
        fake.post(RECEIPT)
      },
      'history-ambiguous',
    ],
  ])('refuses when %s: closes the loop and disarms the gate', async (_label, interfere, reason) => {
    const fake = fakePr({ labels: ['reviewed'], autoMerge: { mergeMethod: 'MERGE' } })
    const { loop, step } = await allocate(fake, 1)
    interfere(fake)
    const error = await refusal(loop.assertFixAllowed(CWD, step))
    expect(error.stop).toMatchObject({
      prState: 'OPEN',
      published: true,
      removed: true,
      autoMergeDisabled: true,
      disarmErrors: [],
    })
    expect({ closed: loop.closed, stopReason: loop.stopReason }).toEqual({ closed: 'stop', stopReason: reason })
    expect(fake.pr.labels.has('reviewed')).toBe(false)
    expect(fake.pr.autoMerge).toBe(null)
    await expect(loop.assertFixAllowed(CWD, step)).rejects.toThrow()
    expect((await strict(fake)).stopReason).toBe(reason)
  })

  it('does not excuse an explicit stop at the second allocation as the loop’s own terminal red', async () => {
    const fake = fakePr()
    const { loop, step } = await allocate(fake, 2)
    fake.post(accounting(2, 2, 'review-bound'))
    await expect(loop.assertFixAllowed(CWD, step)).rejects.toThrow()
    expect(loop.closed).toBe('stop')
  })

  it.each([1, 2])('refuses allocation %i once a later review record appears', async (round) => {
    const fake = fakePr()
    const { loop, step } = await allocate(fake, round)
    fake.post(RED)
    await expect(loop.assertFixAllowed(CWD, step)).rejects.toThrow()
    await expect(loop.assertFixAllowed(CWD, step)).rejects.toThrow()
  })

  it('refuses an allocation that was never persisted', async () => {
    const fake = fakePr()
    const loop = await resumeReviewLoop(CWD, { pr: PR, gh: fake.gh })
    fake.post(RED)
    const step = loop.record('red')
    await expect(loop.assertFixAllowed(CWD, step)).rejects.toThrow()
  })

  it('refuses when the durable allocation has moved past the live loop', async () => {
    const fake = fakePr()
    const { loop, step } = await allocate(fake, 1)
    fake.post(accounting(2, 2))
    await expect(loop.assertFixAllowed(CWD, step)).rejects.toThrow()
  })

  it('refuses when gh answers as another account, even one whose records mirror the loop’s', async () => {
    const fake = fakePr()
    const { loop, step } = await allocate(fake, 1)
    for (const record of [...fake.pr.comments]) fake.post(record.body, 'omp-bot-2')
    fake.pr.me = 'omp-bot-2'
    await expect(loop.assertFixAllowed(CWD, step)).rejects.toThrow()
  })

  it('refuses a copy of the live step, or a non-fix step, without consuming the grant', async () => {
    const fake = fakePr()
    const { loop, step } = await allocate(fake, 1)
    await expect(loop.assertFixAllowed(CWD, { ...step })).rejects.toThrow()
    await expect(loop.assertFixAllowed(CWD, { action: 'land', reviews: 1, fixes: 1 })).rejects.toThrow()
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
})

describe('enforceStop — reads the gate, then publishes and disarms independently', () => {
  const stopped = () => {
    const loop = createReviewLoop({ pr: PR })
    loop.record('red')
    loop.record('red')
    loop.record('red')
    return loop
  }
  const first = (fake, verb) => fake.calls.findIndex((args) => args[0] === 'pr' && args[1] === verb)

  it('reads labels, auto-merge and state before publishing, then disarms what it found', async () => {
    const fake = fakePr({ labels: ['reviewed', 'size:F-full'], autoMerge: { mergeMethod: 'MERGE' } })
    const outcome = await stopped().enforceStop(CWD, { gh: fake.gh })
    expect(outcome).toMatchObject({
      prState: 'OPEN',
      published: true,
      publishError: null,
      readError: null,
      removed: true,
      autoMergeDisabled: true,
      disarmErrors: [],
    })
    expect(first(fake, 'view')).toBeLessThan(first(fake, 'comment'))
    expect([...fake.pr.labels]).toEqual(['size:F-full'])
    expect(fake.pr.autoMerge).toBe(null)
    expect((await strict(fake)).stopReason).toBe('review-bound')
  })

  it('publishes the stop and writes nothing else when the open PR carries no gate', async () => {
    const fake = fakePr({ labels: ['size:F-full'] })
    const outcome = await stopped().enforceStop(CWD, { gh: fake.gh })
    expect(outcome).toMatchObject({
      prState: 'OPEN',
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
    expect(outcome).toMatchObject({ prState: state, published: false, removed: false, autoMergeDisabled: false })
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
    expect(outcome).toMatchObject({ published: true, removed: false, autoMergeDisabled: false })
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
  it('reads the rounds a PR already carries', () => {
    expect(parseReviewRounds('nothing here')).toBe(null)
    expect(parseReviewRounds('<!-- omp-build:review-rounds reviews=3 fixes=2 -->')).toEqual({ reviews: 3, fixes: 2 })
  })

  it('takes the highest marker, so re-posting an old one refunds nothing', () => {
    const text = [
      '<!-- omp-build:review-rounds reviews=2 fixes=2 -->',
      'later, a stale copy of the first round:',
      '<!-- omp-build:review-rounds reviews=1 fixes=1 -->',
    ].join('\n')
    expect(parseReviewRounds(text)).toEqual({ reviews: 2, fixes: 2 })
  })

  it('keeps a sticky stop even when a later count-only marker is higher', () => {
    const text = [
      '<!-- omp-build:review-rounds reviews=3 fixes=2 -->',
      '<!-- omp-build:review-stop reason=review-bound -->',
      '<!-- omp-build:review-rounds reviews=4 fixes=2 -->',
    ].join('\n')
    expect(parseReviewRounds(text)).toEqual({ reviews: 4, fixes: 2, stopReason: 'review-bound' })
  })

  it('resumes a loop on its last round instead of handing out two fresh ones', async () => {
    const loop = await resumeReviewLoop(CWD, { pr: PR, gh: fakePr({ comments: TWO_ROUNDS }).gh })
    expect({ reviews: loop.reviews, fixes: loop.fixes, remaining: loop.remaining }).toEqual({
      reviews: 2,
      fixes: 2,
      remaining: 0,
    })
    expect(loop.record('red').action).toBe('stop')
  })

  it('starts at zero on a PR that has never been reviewed', async () => {
    const loop = await resumeReviewLoop(CWD, { pr: PR, gh: fakePr({ comments: [comment('a plain comment')] }).gh })
    expect({ reviews: loop.reviews, fixes: loop.fixes }).toEqual({ reviews: 0, fixes: 0 })
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
    const view = ['pr', 'view', String(PR), '--json', 'comments']
    const gh = async (cwd, args) => (same(args, view) ? answer : fake.gh(cwd, args))
    await expect(readReviewRounds(CWD, PR, { gh })).rejects.toThrow()
    await expect(resumeReviewLoop(CWD, { pr: PR, gh })).rejects.toThrow()
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

  it('binds to a bot login too', () => {
    const bot = 'omp-build[bot]'
    expect(interpretReviewHistory([comment(RED, bot), comment(RECEIPT, bot)], { me: bot })).toEqual({
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

  it('derives review-bound when the second allocation was never receipted', () => {
    // Any exit between allocating and receipting fix #2: fail closed, no replay.
    expect(interpretReviewHistory(TWO_ROUNDS.slice(0, 5), { me: ME })).toEqual({
      reviews: 2,
      fixes: 2,
      stopReason: 'review-bound',
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
