import { describe, expect, it } from 'vitest'
import {
  boundState,
  ciFixCount,
  commentPageArgs,
  nextReviewStep,
  openPr,
  parseCheckRuns,
  resolveReviewPr,
  reviewRecords,
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

/** @param {unknown[]} args @param {unknown[]} expected */
function same(args, expected) {
  return args.length === expected.length && expected.every((arg, i) => args[i] === arg)
}

/** A PR comment as the review reads it. @param {string} body @param {string} [author] */
function comment(body, author = ME) {
  return { author: { login: author }, body }
}

const HEAD = '0123456789abcdef0123456789abcdef01234567'
/** Distinct commits: a fix's push moves the head, and each review names the head it read. */
const [C1, C2, C3] = ['1', '2', '3'].map((digit) => digit.repeat(40))

/**
 * A review record as dev-review posts it: the marker on the first line, the reviewed head on
 * the second, the verdict last.
 * @param {string} verdict
 * @param {{ before?: string, head?: string }} [opts] a line placed above the verdict; the head line 2 names
 */
function review(verdict, { before, head = HEAD } = {}) {
  return [
    '<!-- omp-build:code-review -->',
    `<!-- omp-build:review-head sha=${head} -->`,
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

/** The record's comment, by the automation login, at `head`. */
const red = (head = HEAD) => comment(review('Request changes', { head }))
const approve = (head = HEAD, verdict = 'Approve') => comment(review(verdict, { head }))
/** Two verdict declarations that disagree: a record whose verdict is unknown. */
const undecided = (head = HEAD) =>
  comment(review('Request changes', { head, before: '**Verdict: Approve** — first draft' }))

/**
 * What the retired accounting left behind, all by the automation login and none of it a
 * review record. The receipt claims an approval of HEAD and names HEAD on line 2 — the two
 * things a reader of "latest comment" would act on.
 */
const LEGACY = [
  comment(
    '<!-- omp-build:review-rounds reviews=9 fixes=9 -->\n<!-- omp-build:review-stop reason=review-bound -->\nReview bound: 9 review(s), 2 of 2 fix round(s) spent.',
  ),
  comment('<!-- omp-build:fix-grant reviews=1 fixes=1 token=0123456789abcdef -->'),
  comment(
    `## Review Fixes Applied\n<!-- omp-build:review-head sha=${HEAD} -->\n\n**Applied:** 1 cause(s)\n\n**Verdict: Approve** — receipt`,
  ),
]

/**
 * One PR as `gh` shows it, and the branch `git` is on. Stateful: label and auto-merge writes
 * change what the next view reads. Only exact argv is answered — anything else throws, so a
 * wrong query can never read as an empty history. Nothing here reaches a real `gh` or `git`.
 */
function fakePr({
  me = ME,
  comments = [],
  labels = [],
  autoMerge = null,
  state = 'OPEN',
  branch = BRANCH,
  head = HEAD,
  /** The branch's PRs as `gh pr list --state all` lists them, a raw answer, or the Error the lookup throws. */
  branchPrs = [listing(PR, state)],
  /** Check runs by sha. A missing sha is an empty page, not a failed read. */
  checks = {},
  /** A sha whose check-run read throws, instead of returning `checks`. */
  checkErrors = {},
  /** Commit statuses by sha. A missing sha is an empty page. */
  statuses = {},
} = {}) {
  const pr = {
    me,
    comments: [...comments],
    labels: new Set(labels),
    autoMerge,
    state,
    branch,
    branchPrs,
    headRefOid: head,
    checks,
    checkErrors,
    statuses,
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
        if (field === 'labels') view.labels = [...pr.labels].map((name) => ({ name }))
        else if (field === 'autoMergeRequest') view.autoMergeRequest = pr.autoMerge
        else if (field === 'state') view.state = pr.state
        else if (field === 'headRefOid') view.headRefOid = pr.headRefOid
        else if (field === 'baseRefName') view.baseRefName = 'main'
        else throw new Error(`unexpected field: ${field}`)
      }
      return JSON.stringify(view)
    }
    if (same(args, ['pr', 'edit', n, '--remove-label', 'reviewed'])) {
      pr.labels.delete('reviewed')
      return ''
    }
    if (same(args, ['pr', 'merge', n, '--disable-auto'])) {
      pr.autoMerge = null
      return ''
    }
    if (same(args, ['repo', 'view', '--json', 'nameWithOwner'])) return JSON.stringify({ nameWithOwner: 'acme/app' })
    const endpoint = args[0] === 'api' ? String(args.at(-1)) : ''
    if (endpoint.includes('/check-runs')) {
      const sha = endpoint.match(/commits\/([0-9a-f]{40})/)?.[1]
      if (sha && pr.checkErrors[sha]) throw pr.checkErrors[sha]
      const runs = sha ? (pr.checks[sha] ?? []) : []
      return JSON.stringify([{ total_count: runs.length, check_runs: runs }])
    }
    if (endpoint.includes('/statuses')) {
      const sha = endpoint.match(/commits\/([0-9a-f]{40})/)?.[1]
      return JSON.stringify([sha ? (pr.statuses[sha] ?? []) : []])
    }
    if (endpoint.includes('/actions/runs/')) return JSON.stringify({ name: 'ci', path: '.github/workflows/ci.yml' })
    if (endpoint.includes('required_status_checks')) return JSON.stringify({ contexts: ['ci'] })
    if (endpoint.includes('/rules/branches/')) return JSON.stringify([])
    throw new Error(`unexpected gh call: ${args.join(' ')}`)
  }
  const git = async (_cwd, args) => {
    calls.push(['git', ...args])
    if (same(args, ['branch', '--show-current'])) return pr.branch
    throw new Error(`unexpected git call: ${args.join(' ')}`)
  }
  return { gh, git, calls, pr }
}

/** @param {{ gh: Function, git: Function }} fake */
const deps = ({ gh, git }) => ({ gh, git })

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

describe('reviewRecords — strict, author-bound, first-line records', () => {
  it('reads nothing from an empty history', () => {
    expect(reviewRecords([], { me: ME })).toEqual({ reviews: 0, verdict: null, head: null, reds: 0, approvedHeads: [] })
  })

  it('counts every record and reads the verdict and head of the latest', () => {
    expect(reviewRecords([red(C1), approve(C2, 'Approve with comments')], { me: ME })).toEqual({
      reviews: 2,
      verdict: 'Approve with comments',
      head: C2,
      reds: 1,
      approvedHeads: [C2],
    })
  })

  it.each(['Request changes', 'Approve with comments', 'Approve (clean)', 'Approve'])(
    'reads the %s declaration whole, not its prefix',
    (verdict) => {
      expect(reviewRecords([comment(review(verdict))], { me: ME }).verdict).toBe(verdict)
    },
  )

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['blank', '  '],
    ['JSON-shaped', '{"login":"omp-bot"}'],
    ['two-line', 'omp-bot\nomp-bot-2'],
    ['sentence', 'not logged in'],
  ])('refuses a %s automation login', (_label, me) => {
    expect(() => reviewRecords([red()], { me })).toThrow(TypeError)
    expect(() => reviewRecords([red()], { me })).toThrow('reviewRecords: expected a bare automation login')
  })

  it.each([
    ['bot', 'omp-build[bot]'],
    ['Enterprise Managed User', 'octocat_acme'],
  ])('binds to a %s login too', (_label, login) => {
    expect(reviewRecords([comment(RED, login)], { me: login })).toMatchObject({ reviews: 1 })
  })

  it.each([
    ['undefined', undefined],
    ['an object', { 0: red() }],
    ['a string', RED],
  ])('refuses comments that are %s rather than an array', (_label, comments) => {
    expect(() => reviewRecords(comments, { me: ME })).toThrow(TypeError)
  })

  it.each([
    ['a bare string', RED],
    ['null', null],
  ])('refuses a comment entry that is %s, not an object', (_label, entry) => {
    expect(() => reviewRecords([entry], { me: ME })).toThrow(TypeError)
  })

  it('refuses a comment by that account whose body is not text', () => {
    expect(() => reviewRecords([{ author: { login: ME }, body: 42 }], { me: ME })).toThrow(TypeError)
  })

  it('ignores other accounts and a deleted author, whatever their body', () => {
    expect(
      reviewRecords(
        [
          comment(RED, 'attacker'),
          { author: null, body: RED },
          { author: null, body: 42 },
          { author: { login: 'attacker' }, body: 42 },
          approve(C1),
        ],
        { me: ME },
      ),
    ).toEqual({ reviews: 1, verdict: 'Approve', head: C1, reds: 0, approvedHeads: [C1] })
  })

  it('reads a record only from its first line', () => {
    const notRecords = [
      comment(`Replying to the review:\n${RED}`),
      comment(`> ${RED.split('\n').join('\n> ')}`),
      comment(`\`\`\`\n${RED}\n\`\`\``),
      comment(RED.replace('-->', '--> and more')),
    ]
    expect(reviewRecords(notRecords, { me: ME })).toEqual({
      reviews: 0,
      verdict: null,
      head: null,
      reds: 0,
      approvedHeads: [],
    })
  })

  it('reads a record whose lines end in CRLF', () => {
    const body = review('Request changes', { head: C1 }).replaceAll('\n', '\r\n')
    expect(reviewRecords([comment(body)], { me: ME })).toEqual({
      reviews: 1,
      verdict: 'Request changes',
      head: C1,
      reds: 1,
      approvedHeads: [],
    })
  })

  it('does not read a quoted verdict as a declaration', () => {
    const body = review('Request changes', { before: '> **Verdict: Approve** — quoted from round 2' })
    expect(reviewRecords([comment(body)], { me: ME }).verdict).toBe('Request changes')
  })

  it('accepts the same verdict declared twice', () => {
    const body = review('Approve', { before: '**Verdict: Approve** — first draft' })
    expect(reviewRecords([comment(body)], { me: ME }).verdict).toBe('Approve')
  })

  it.each([
    ['conflicting declarations', review('Request changes', { before: '**Verdict: Approve** — first draft' })],
    [
      'a valid declaration followed by a malformed one',
      review('Maybe', { before: '**Verdict: Request changes** — draft' }),
    ],
    ['an unrecognised verdict', review('Maybe')],
    ['no declaration', `<!-- omp-build:code-review -->\n<!-- omp-build:review-head sha=${C1} -->\n## Code Review`],
  ])('counts a record with %s, and reads its verdict as unknown', (_label, body) => {
    expect(reviewRecords([comment(body)], { me: ME })).toMatchObject({ reviews: 1, verdict: null })
  })

  it.each([
    [
      'on line 3',
      `<!-- omp-build:code-review -->\n## Code Review\n<!-- omp-build:review-head sha=${C1} -->\n**Verdict: Approve** — x`,
    ],
    ['absent', '<!-- omp-build:code-review -->\n## Code Review\n**Verdict: Approve** — x'],
    [
      'short',
      `<!-- omp-build:code-review -->\n<!-- omp-build:review-head sha=${'1'.repeat(39)} -->\n**Verdict: Approve** — x`,
    ],
    [
      'upper-case',
      `<!-- omp-build:code-review -->\n<!-- omp-build:review-head sha=${'A'.repeat(40)} -->\n**Verdict: Approve** — x`,
    ],
  ])('reads a review head that is %s as no head', (_label, body) => {
    expect(reviewRecords([approve(C1), comment(body)], { me: ME })).toEqual({
      reviews: 2,
      verdict: 'Approve',
      head: null,
      reds: 0,
      approvedHeads: [C1],
    })
  })

  it.each([
    ['three reds', [red(C1), red(C2), red(C3)], 3, []],
    ['two reds', [red(C1), red(C2)], 2, []],
    ['a third approval', [red(C1), red(C2), approve(C3)], 2, [C3]],
    ['two approvals then a red', [approve(C1), approve(C2), red(C3)], 1, [C1, C2]],
    ['a third record with no verdict', [red(C1), red(C2), undecided(C3)], 2, []],
    ['a red inside the bound, then approvals', [red(C1), approve(C2), approve(C3)], 1, [C2, C3]],
    ['four approvals', [approve(C1), approve(C1), approve(C2), approve(C3)], 0, [C1, C1, C2, C3]],
    ['a red past the bound that a later approval follows', [red(C1), red(C2), red(C3), approve(C3)], 3, [C3]],
    ['two reds and a third by another account', [red(C1), red(C2), comment(RED, 'attacker')], 2, []],
  ])('counts reds and approved heads for %s', (_label, comments, reds, approvedHeads) => {
    expect(reviewRecords(comments, { me: ME })).toMatchObject({ reds, approvedHeads })
  })

  it('keeps the latest verdict and head when a green follows three reds', () => {
    expect(reviewRecords([red(C1), red(C2), red(C3), approve(C3)], { me: ME })).toEqual({
      reviews: 4,
      verdict: 'Approve',
      head: C3,
      reds: 3,
      approvedHeads: [C3],
    })
  })

  it.each([
    ['one red', [red(C1)]],
    ['two reds', [red(C1), red(C2)]],
    ['three reds', [red(C1), red(C2), red(C3)]],
    ['no review at all', []],
  ])('ignores retired markers and receipts by the same account after %s', (_label, history) => {
    expect(reviewRecords([...history, ...LEGACY], { me: ME })).toEqual(reviewRecords(history, { me: ME }))
  })
})

/** A completed failing check named `ci`, so the test protection set prices it. */
function failRun(name = 'ci', at = '2026-01-01T00:00:00Z', id = 1, conclusion = 'failure') {
  return {
    name,
    status: 'completed',
    conclusion,
    completed_at: at,
    id,
    workflow: 'ci',
    details_url: 'https://github.com/acme/app/actions/runs/9',
  }
}

function passRun(at = '2026-01-02T00:00:00Z', id = 2) {
  return { ...failRun('ci', at, id, 'success'), conclusion: 'success' }
}

describe('nextReviewStep — the bound is two reads of the review records', () => {
  const isRead = (args) =>
    args[0] === 'api' || (args[0] === 'pr' && args[1] === 'view') || (args[0] === 'repo' && args[1] === 'view')
  /** Every call that is not a read. */
  const writesOf = (fake) => fake.calls.filter((args) => !isRead(args))
  const REMOVE_LABEL = ['pr', 'edit', String(PR), '--remove-label', 'reviewed']
  const DISABLE_AUTO = ['pr', 'merge', String(PR), '--disable-auto']
  /** A PR that is labelled `reviewed` with auto-merge on: anything the step fails to disarm shows up. */
  const ARMED = { labels: ['reviewed'], autoMerge: { mergeMethod: 'MERGE' } }
  const STOP = { action: 'stop', reason: 'review-bound', message: expect.any(String) }

  /** One decision over a PR, and what it wrote. */
  async function decide(options, call = {}) {
    const checks = options.checks ?? (call.ciFailed ? { [options.head ?? HEAD]: [failRun()] } : {})
    const fake = fakePr({ ...options, checks })
    const step = await nextReviewStep(CWD, PR, { ...call, gh: fake.gh })
    return { step, writes: writesOf(fake), fake }
  }

  describe('the bound', () => {
    it.each([
      ['R1 red at the head: one fix left after this one', [red(C1)], C1, { action: 'fix', reviews: 1, remaining: 1 }],
      ['R2 red at the head: the last fix', [red(C1), red(C2)], C2, { action: 'fix', reviews: 2, remaining: 0 }],
      ['R3 red: no fix is left', [red(C1), red(C2), red(C3)], C3, { ...STOP, reviews: 3 }],
      ['a stop whatever the head: the PR moved after R3', [red(C1), red(C2), red(C3)], HEAD, { ...STOP, reviews: 3 }],
      [
        'approve, approve, request changes',
        [approve(C1), approve(C2), red(C3)],
        C3,
        { action: 'fix', reviews: 3, remaining: 1 },
      ],
      ['R3 approve: the PR can land', [red(C1), red(C2), approve(C3)], C3, { action: 'land', reviews: 3 }],
      ['R1 approve', [approve(C1, 'Approve (clean)')], C1, { action: 'land', reviews: 1 }],
      ['R2 approve with comments', [red(C1), approve(C2, 'Approve with comments')], C2, { action: 'land', reviews: 2 }],
      [
        'a third red by another account is not a review',
        [red(C1), red(C2), comment(review('Request changes', { head: C3 }), 'attacker')],
        C2,
        { action: 'fix', reviews: 2, remaining: 0 },
      ],
    ])('%s', async (_label, comments, head, expected) => {
      const { step, writes } = await decide({ comments, head })
      expect(step).toEqual(expected)
      expect(writes).toEqual([])
    })

    it('stays stopped through an approval of the current head after three reds', async () => {
      const { step, writes } = await decide({ comments: [red(C1), red(C2), red(C3), approve(C3)], head: C3 })
      expect(step).toEqual({ ...STOP, reviews: 4 })
      expect(writes).toEqual([])
    })

    it('stops for the bound, not for ci-failed, when a red check follows a spent bound', async () => {
      const comments = [red(C1), red(C2), red(C3), approve(C3)]
      const { step } = await decide({ comments, head: C3 }, { ciFailed: true })
      expect(step).toEqual({ ...STOP, reviews: 4 })
    })
  })

  describe('one fix per review', () => {
    it('asks for a new review once a fix moved the head, and writes nothing', async () => {
      const { step, writes } = await decide({ comments: [red(C1)], head: C2 })
      expect(step).toEqual({ action: 'review', reason: 'head-moved', reviews: 1 })
      expect(writes).toEqual([])
    })

    it('does not take an approval of another commit for the current one', async () => {
      const { step, writes } = await decide({ comments: [approve(C1)], head: C2 })
      expect(step).toEqual({ action: 'review', reason: 'head-moved', reviews: 1 })
      expect(writes).toEqual([])
    })
  })

  describe('ci-failed', () => {
    it.each([
      ['R1 approve', [approve(C1)], C1, { action: 'fix', reason: 'ci-failed', reviews: 1, remaining: 1 }],
      ['R2 approve', [red(C1), approve(C2)], C2, { action: 'fix', reason: 'ci-failed', reviews: 2, remaining: 0 }],
    ])('fixes a red check on the approved head: %s', async (_label, comments, head, expected) => {
      const { step, writes } = await decide({ comments, head }, { ciFailed: true })
      expect(step).toEqual(expected)
      expect(writes).toEqual([])
    })

    it('stops on a red check once R3 approved: no fix is left', async () => {
      const { step } = await decide({ comments: [red(C1), red(C2), approve(C3)], head: C3 }, { ciFailed: true })
      expect(step).toEqual({ action: 'stop', reason: 'ci-failed', reviews: 3, message: expect.any(String) })
    })

    it.each([
      ['a red latest record', [approve(C1), red(C1)], C1],
      ['an approval of another commit', [approve(C1)], C2],
      ['no review record', [], C1],
      ['a latest record with no verdict', [undecided(C1)], C1],
    ])('refuses a ci-failed ask over %s, and writes nothing', async (_label, comments, head) => {
      const fake = fakePr({ ...ARMED, comments, head })
      await expect(nextReviewStep(CWD, PR, { ciFailed: true, gh: fake.gh })).rejects.toThrow(
        'a ci-failed fix needs the latest review record to approve the current head',
      )
      expect(writesOf(fake)).toEqual([])
    })
  })

  describe('posted', () => {
    it.each([
      ['a red', 'Request changes', [red(C1)], { action: 'fix', reviews: 1, remaining: 1 }],
      ['an approval', 'Approve (clean)', [approve(C1, 'Approve (clean)')], { action: 'land', reviews: 1 }],
    ])('decides from %s that is the latest record', async (_label, verdict, comments, expected) => {
      const { step } = await decide({ comments, head: C1 }, { posted: { verdict, head: C1 } })
      expect(step).toEqual(expected)
    })

    it.each([
      ['has a different verdict', [approve(C1)], { verdict: 'Request changes', head: C1 }],
      ['names another commit', [red(C1)], { verdict: 'Request changes', head: C2 }],
      ['is not yet on the PR', [], { verdict: 'Request changes', head: C1 }],
      ['was followed by a later record', [red(C1), approve(C2)], { verdict: 'Request changes', head: C1 }],
    ])('refuses a posted review that %s, and writes nothing', async (_label, comments, posted) => {
      const fake = fakePr({ ...ARMED, comments, head: C1 })
      await expect(nextReviewStep(CWD, PR, { posted, gh: fake.gh })).rejects.toThrow(
        'the latest review record is not the one just posted',
      )
      expect(writesOf(fake)).toEqual([])
    })

    it.each([
      ['an unknown verdict', { verdict: 'Maybe', head: C1 }],
      ['a short head', { verdict: 'Request changes', head: 'abc' }],
      ['no head', { verdict: 'Request changes' }],
      ['a bare verdict', 'Request changes'],
      ['null', null],
    ])('refuses a posted review with %s as a TypeError, and writes nothing', async (_label, posted) => {
      const fake = fakePr({ ...ARMED, comments: [red(C1)], head: C1 })
      await expect(nextReviewStep(CWD, PR, { posted, gh: fake.gh })).rejects.toThrow(TypeError)
      expect(writesOf(fake)).toEqual([])
    })
  })

  describe('review', () => {
    it.each([
      ['a PR with no comment', []],
      ['a PR whose only comments are another account’s review and prose', [comment(RED, 'attacker'), comment('LGTM')]],
    ])('asks for a first review on %s', async (_label, comments) => {
      const { step, writes } = await decide({ comments })
      expect(step).toEqual({ action: 'review', reason: 'no-review', reviews: 0 })
      expect(writes).toEqual([])
    })

    it.each([
      ['a first review', [undecided(C1)], C1, 1],
      ['a second review', [red(C1), undecided(C2)], C2, 2],
      ['a third record with no verdict', [red(C1), red(C2), undecided(C3)], C3, 3],
    ])('asks again when %s of the current head declares no verdict', async (_label, comments, head, reviews) => {
      const { step, writes } = await decide({ comments, head })
      expect(step).toEqual({ action: 'review', reason: 'no-verdict', reviews })
      expect(writes).toEqual([])
    })
  })

  describe('disarming', () => {
    const DISARMED = [
      ['a fix', [red(HEAD)], {}, { action: 'fix', reviews: 1, remaining: 1 }],
      [
        'a ci-failed fix',
        [approve(HEAD)],
        { ciFailed: true },
        { action: 'fix', reason: 'ci-failed', reviews: 1, remaining: 1 },
      ],
      ['a stop', [red(C1), red(C2), red(HEAD)], {}, { ...STOP, reviews: 3 }],
      ['a review of another commit', [red(C1)], {}, { action: 'review', reason: 'head-moved', reviews: 1 }],
      ['a review with no record yet', [], {}, { action: 'review', reason: 'no-review', reviews: 0 }],
      [
        'a review of an undecided record',
        [undecided(HEAD)],
        {},
        { action: 'review', reason: 'no-verdict', reviews: 1 },
      ],
      ['a land a review is about to start on', [approve(HEAD)], { reviewing: true }, { action: 'land', reviews: 1 }],
    ]

    it.each(DISARMED)(
      '%s on an open armed PR drops the label, then auto-merge, and says so',
      async (_label, comments, call, expected) => {
        const { step, writes, fake } = await decide({ ...ARMED, comments }, call)
        expect(step).toEqual({ ...expected, disarmed: true })
        expect(writes).toEqual([REMOVE_LABEL, DISABLE_AUTO])
        expect([...fake.pr.labels]).toEqual([])
        expect(fake.pr.autoMerge).toBe(null)
      },
    )

    it('drops only the label when auto-merge is off', async () => {
      const { step, writes } = await decide({ labels: ['reviewed'], comments: [red(HEAD)] })
      expect(step).toEqual({ action: 'fix', reviews: 1, remaining: 1, disarmed: true })
      expect(writes).toEqual([REMOVE_LABEL])
    })

    it('drops only auto-merge when the label is off', async () => {
      const { step, writes } = await decide({ autoMerge: { mergeMethod: 'MERGE' }, comments: [red(HEAD)] })
      expect(step).toEqual({ action: 'fix', reviews: 1, remaining: 1, disarmed: true })
      expect(writes).toEqual([DISABLE_AUTO])
    })

    it('leaves other labels alone', async () => {
      const { step, writes, fake } = await decide({ labels: ['size:F-lite'], comments: [red(HEAD)] })
      expect(step).not.toHaveProperty('disarmed')
      expect(writes).toEqual([])
      expect([...fake.pr.labels]).toEqual(['size:F-lite'])
    })

    it.each(DISARMED)(
      '%s on an unarmed PR writes nothing and does not claim a disarm',
      async (_label, comments, call, expected) => {
        const { step, writes } = await decide({ comments }, call)
        expect(step).toEqual(expected)
        expect(step).not.toHaveProperty('disarmed')
        expect(writes).toEqual([])
      },
    )

    it('leaves the gate of a PR it lands', async () => {
      const { step, writes, fake } = await decide({ ...ARMED, comments: [approve(HEAD)] })
      expect(step).toEqual({ action: 'land', reviews: 1 })
      expect(writes).toEqual([])
      expect(fake.pr.labels.has('reviewed')).toBe(true)
      expect(fake.pr.autoMerge).not.toBe(null)
    })

    it.each(['MERGED', 'CLOSED'])('writes nothing on a %s PR, whatever it decides', async (state) => {
      const fix = await decide({ ...ARMED, state, comments: [red(HEAD)] })
      expect(fix.step).toEqual({ action: 'fix', reviews: 1, remaining: 1 })
      expect(fix.writes).toEqual([])
      const stop = await decide({ ...ARMED, state, comments: [red(C1), red(C2), red(HEAD)] })
      expect(stop.step).toEqual({ ...STOP, reviews: 3 })
      expect(stop.writes).toEqual([])
    })
  })

  describe('the retired markers are inert', () => {
    it.each([
      ['a red at the head: still one fix left', [red(HEAD)], {}, { action: 'fix', reviews: 1, remaining: 1 }],
      ['two reds: still the last fix', [red(C1), red(HEAD)], {}, { action: 'fix', reviews: 2, remaining: 0 }],
      ['an approval: a stop marker does not stop it', [approve(HEAD)], {}, { action: 'land', reviews: 1 }],
      [
        'a ci-failed ask on an approval',
        [approve(HEAD)],
        { ciFailed: true },
        { action: 'fix', reason: 'ci-failed', reviews: 1, remaining: 1 },
      ],
      ['no review: the receipt’s approval is no record', [], {}, { action: 'review', reason: 'no-review', reviews: 0 }],
      [
        'a red of another commit: the receipt’s head is not the review’s',
        [red(C1)],
        {},
        { action: 'review', reason: 'head-moved', reviews: 1 },
      ],
    ])('%s', async (_label, history, call, expected) => {
      const bare = await decide({ ...ARMED, comments: history }, call)
      const withLegacy = await decide({ ...ARMED, comments: [...history, ...LEGACY] }, call)
      expect(withLegacy.step).toEqual(bare.step)
      expect(withLegacy.writes).toEqual(bare.writes)
      expect(withLegacy.step).toMatchObject(expected)
    })
  })

  describe('reading', () => {
    it('reads the comment pages in creation order, whatever order they arrive in', async () => {
      const fake = fakePr({ head: C2 })
      const entry = (body, created_at) => ({ user: { login: ME }, body, created_at })
      const pages = [
        [entry(review('Approve', { head: C2 }), '2026-01-02T00:00:00Z')],
        [entry(review('Request changes', { head: C1 }), '2026-01-01T00:00:00Z')],
      ]
      const gh = async (cwd, args) => (same(args, commentPageArgs(PR)) ? JSON.stringify(pages) : fake.gh(cwd, args))
      expect(await nextReviewStep(CWD, PR, { gh })).toEqual({ action: 'land', reviews: 2 })
    })

    it('reads the records of the account the identity query names', async () => {
      const comments = [comment(review('Request changes'), 'omp-bot'), comment(review('Approve'), 'other-bot')]
      const { step } = await decide({ me: 'other-bot', comments })
      expect(step).toEqual({ action: 'land', reviews: 1 })
    })

    it.each([undefined, null, ''])('refuses pr %o', async (pr) => {
      const fake = fakePr()
      await expect(nextReviewStep(CWD, pr, { gh: fake.gh })).rejects.toThrow(TypeError)
      expect(fake.calls).toEqual([])
    })

    const ASKS = {
      identity: IDENTITY,
      pages: commentPageArgs(PR),
      gate: ['pr', 'view', String(PR), '--json', 'headRefOid,state,labels,autoMergeRequest'],
    }
    it.each([
      ['identity', 'the identity query fails', new Error('gh: not logged in')],
      ['identity', 'the identity is empty', ''],
      ['identity', 'the identity is JSON-shaped', '{"login":"omp-bot"}'],
      ['identity', 'the identity is a sentence', 'not logged in'],
      ['pages', 'the comment pages fail', new Error('gh: HTTP 502')],
      ['pages', 'the comment pages are not JSON', 'not json'],
      ['pages', 'the comment pages are not a list of pages', '{}'],
      ['pages', 'the comment pages are one unwrapped page', JSON.stringify([{ body: RED }])],
      [
        'pages',
        'a comment has no body',
        JSON.stringify([[{ user: { login: ME }, created_at: '2026-01-01T00:00:00Z' }]]),
      ],
      ['gate', 'the PR view fails', new Error('gh: HTTP 502')],
      ['gate', 'the PR view is not JSON', 'not json'],
      ['gate', 'the PR view carries no labels', JSON.stringify({ headRefOid: HEAD, state: 'OPEN' })],
    ])('refuses to decide when %s: %s, and writes nothing', async (ask, _label, answer) => {
      // A red at the head on an armed PR is a fix that disarms — had the read been believed.
      const fake = fakePr({ ...ARMED, comments: [red(HEAD)] })
      const gh = async (cwd, args) => {
        if (!same(args, ASKS[ask])) return fake.gh(cwd, args)
        fake.calls.push(args)
        if (answer instanceof Error) throw answer
        return answer
      }
      await expect(nextReviewStep(CWD, PR, { gh })).rejects.toThrow()
      expect(writesOf(fake)).toEqual([])
    })
  })

  describe('the allowance counts fixes', () => {
    const CI = { action: 'stop', reason: 'ci-failed', message: expect.any(String) }

    it('approve, approve, red is a fix: approvals spend nothing', async () => {
      const { step } = await decide({ comments: [approve(C1), approve(C2), red(C3)], head: C3 })
      expect(step).toEqual({ action: 'fix', reviews: 3, remaining: 1 })
    })

    it('three CI failures: the third stops ci-failed, not review-bound', async () => {
      const checks = {
        [C1]: [failRun()],
        [C2]: [failRun('ci', '2026-01-02T00:00:00Z', 2)],
        [C3]: [failRun('ci', '2026-01-03T00:00:00Z', 3)],
      }
      const { step } = await decide(
        { comments: [approve(C1), approve(C2), approve(C3)], head: C3, checks },
        { ciFailed: true },
      )
      expect(step).toEqual({ ...CI, reviews: 3 })
    })

    it('a green re-run of the first failure leaves the third CI failure a fix', async () => {
      const checks = {
        [C1]: [failRun('ci', '2026-01-01T00:00:00Z', 1), passRun()],
        [C2]: [failRun('ci', '2026-01-02T00:00:00Z', 3)],
        [C3]: [failRun('ci', '2026-01-03T00:00:00Z', 4)],
      }
      const { step } = await decide(
        { comments: [approve(C1), approve(C2), approve(C3)], head: C3, checks },
        { ciFailed: true },
      )
      expect(step).toEqual({ action: 'fix', reason: 'ci-failed', reviews: 3, remaining: 0 })
    })

    it('a red after an approval whose check failed is the spent third fix', async () => {
      const first = await decide({ comments: [red(C1)], head: C1 })
      expect(first.step).toEqual({ action: 'fix', reviews: 1, remaining: 1 })
      const second = await decide(
        { comments: [red(C1), approve(C2)], head: C2, checks: { [C2]: [failRun()] } },
        { ciFailed: true },
      )
      expect(second.step).toEqual({ action: 'fix', reason: 'ci-failed', reviews: 2, remaining: 0 })
      const third = await decide({ comments: [red(C1), approve(C2), red(C3)], head: C3, checks: { [C2]: [failRun()] } })
      expect(third.step).toEqual({ ...STOP, reviews: 3 })
    })

    it('a stop holds through a later green', async () => {
      const { step } = await decide({ comments: [red(C1), red(C2), red(C3), approve(C3)], head: C3 })
      expect(step).toEqual({ ...STOP, reviews: 4 })
    })

    it('two approvals of one sha with a failed check are one CI fix', async () => {
      const { step } = await decide(
        { comments: [approve(C1), approve(C1)], head: C1, checks: { [C1]: [failRun()] } },
        { ciFailed: true },
      )
      expect(step).toEqual({ action: 'fix', reason: 'ci-failed', reviews: 2, remaining: 1 })
      expect(ciFixCount({ [C1]: { checks: [failRun()], statuses: [] } }, ['ci'])).toBe(1)
    })

    it('a failure on a sha with no approving record counts zero', () => {
      expect(ciFixCount({ [C1]: { checks: [failRun()], statuses: [] } }, ['ci'])).toBe(1)
      expect(ciFixCount({}, ['ci'])).toBe(0)
      expect(boundState({ reds: 1, ciFixes: 0 })).toEqual({ fixes: 1, spent: false })
    })

    it('does not grant a ci-failed fix once the latest run is green', async () => {
      await expect(
        decide({ comments: [approve(C1)], head: C1, checks: { [C1]: [failRun(), passRun()] } }, { ciFailed: true }),
      ).rejects.toThrow('granted only when the current head is a counted CI fix')
      expect(ciFixCount({ [C1]: { checks: [failRun(), passRun()], statuses: [] } }, ['ci'])).toBe(0)
    })

    it('counts startup_failure, and a required status when no check run exists', () => {
      expect(
        ciFixCount({ [C1]: { checks: [failRun('ci', '2026-01-01T00:00:00Z', 1, 'startup_failure')], statuses: [] } }, [
          'ci',
        ]),
      ).toBe(1)
      expect(
        ciFixCount(
          {
            [C2]: {
              checks: [],
              statuses: [{ context: 'ci', state: 'error', updated_at: '2026-01-01T00:00:00Z', id: 1 }],
            },
          },
          ['ci'],
        ),
      ).toBe(1)
      expect(boundState({ reds: 2, ciFixes: 1 })).toEqual({ fixes: 3, spent: true })
      expect(boundState({ reds: 2, ciFixes: 0 })).toEqual({ fixes: 2, spent: false })
    })

    it('rejects an incomplete check-run page', () => {
      expect(() => parseCheckRuns(JSON.stringify([{ total_count: 2, check_runs: [failRun()] }]))).toThrow(
        'not the last page',
      )
    })

    it('skips an unreadable historical head that cannot spend the allowance', async () => {
      const { step } = await decide({
        comments: [red(C1), approve(C2), approve(C3)],
        head: C3,
        checkErrors: { [C2]: new Error('gh: HTTP 502') },
        checks: { [C3]: [passRun()] },
      })
      expect(step).toEqual({ action: 'land', reviews: 3 })
    })

    it('throws when an unreadable head could spend the allowance', async () => {
      await expect(
        decide({
          comments: [red(C1), red(C2), approve(C3)],
          head: C3,
          checkErrors: { [C3]: new Error('gh: HTTP 502') },
        }),
      ).rejects.toThrow('could be spent')
    })

    it('a 404 on classic protection is no classic protection, and the ruleset is priced', async () => {
      const fake = fakePr({ comments: [approve(C1)], head: C1, checks: { [C1]: [failRun()] } })
      const gh = async (cwd, args) => {
        const endpoint = args[0] === 'api' ? String(args.at(-1)) : ''
        if (endpoint.includes('required_status_checks')) throw new Error('gh: HTTP 404')
        if (endpoint.includes('/rules/branches/')) {
          return JSON.stringify([
            { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'deploy' }] } },
          ])
        }
        return fake.gh(cwd, args)
      }
      // 'deploy' is required and no run names it, so the 'ci' failure is not a CI fix.
      // A hard 404 throws 'protection read failed'; an ignored ruleset counts every check and grants the fix.
      await expect(nextReviewStep('/tmp/omp-rc1-absent-stack', PR, { ciFailed: true, gh })).rejects.toThrow(
        'granted only when the current head is a counted CI fix',
      )
    })

    it('a 403 on the classic protection read still fails closed', async () => {
      const fake = fakePr({ comments: [approve(C1)], head: C1, checks: { [C1]: [failRun()] } })
      const gh = async (cwd, args) => {
        const endpoint = args[0] === 'api' ? String(args.at(-1)) : ''
        if (endpoint.includes('required_status_checks')) throw new Error('gh: HTTP 403')
        return fake.gh(cwd, args)
      }
      await expect(nextReviewStep('/tmp/omp-rc1-absent-stack', PR, { ciFailed: true, gh })).rejects.toThrow(
        'protection read failed',
      )
      expect(writesOf(fake)).toEqual([])
    })
  })
})
