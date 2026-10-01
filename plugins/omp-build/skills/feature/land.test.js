import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  applyCiWatchExit,
  disarmReviewedBeforePush,
  interpretReviewHistory,
  landPr,
  parseRequiredContexts,
} from './workflow.js'

/** A checkout with the given files, relative path → content. */
function checkout(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'land-'))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  return dir
}

describe('parseRequiredContexts', () => {
  it('parses classic contexts and checks', () => {
    const json = JSON.stringify({
      contexts: ['ci', 'lint'],
      checks: [{ context: 'trufflehog' }],
    })
    expect([...parseRequiredContexts(json)].sort()).toEqual(['ci', 'lint', 'trufflehog'])
  })

  it('parses ruleset required_status_checks rules', () => {
    const json = JSON.stringify([
      {
        type: 'required_status_checks',
        parameters: { required_status_checks: [{ context: 'ci' }, { context: 'Review' }] },
      },
    ])
    expect([...parseRequiredContexts(json)].sort()).toEqual(['Review', 'ci'])
  })

  it('returns empty set on invalid json', () => {
    expect(parseRequiredContexts('not-json').size).toBe(0)
  })
})

const EVENT_AT = '2026-09-29T10:00:05Z'
const BEFORE_AT = '2026-09-29T09:00:00Z'
const EVENTS_JQ = '.[] | select(.event == "labeled" and .label.name == "reviewed") | .created_at'
const EVENTS_CALL = ['api', 'repos/acme/app/issues/7/events', '--paginate', '--jq', EVENTS_JQ]
/** Default: no prior label event, then the post-add time. */
const EVENTS_FIRST = ['', EVENT_AT]

const ME = 'omp-bot'
/** The one query the automation login comes from. */
const IDENTITY = ['api', 'user', '--jq', '.login']
/** @param {unknown[]} args @param {unknown[]} expected */
const same = (args, expected) => args.length === expected.length && expected.every((arg, i) => args[i] === arg)
/** A review record as dev-review posts it: the marker on the first line, the verdict last. @param {string} verdict */
const review = (verdict) => `<!-- omp-build:code-review -->\n## Code Review\n\n**Verdict: ${verdict}** — summary`
const RED = review('Request changes')
const GREEN = review('Approve (clean)')
const RECEIPT = '## Review Fixes Applied\n\n**Applied:** 1 cause(s)'
/** What the loop persists. @param {number} reviews @param {number} fixes @param {string} [stop] */
const accounting = (reviews, fixes, stop) =>
  [
    `<!-- omp-build:review-rounds reviews=${reviews} fixes=${fixes} -->`,
    ...(stop === undefined ? [] : [`<!-- omp-build:review-stop reason=${stop} -->`]),
    `Review bound: ${reviews} review(s), ${fixes} of 2 fix round(s) spent.`,
  ].join('\n')
/** @param {string} body */
const byMe = (body) => ({ author: { login: ME }, body })
/** A first-round approval of a named commit, then the count the loop persisted. */
const APPROVED_HEAD = '0123456789abcdef0123456789abcdef01234567'
const APPROVED = [
  byMe(
    `<!-- omp-build:code-review -->\n<!-- omp-build:review-head sha=${APPROVED_HEAD} -->\n## Code Review\n\n**Verdict: Approve (clean)** — summary`,
  ),
  byMe(accounting(1, 0)),
]
/** Two completed rounds: each red persisted as an allocation, each fix receipted. */
const TWO_ROUNDS = [byMe(RED), byMe(accounting(1, 1)), byMe(RECEIPT), byMe(RED), byMe(accounting(2, 2)), byMe(RECEIPT)]
/** PR #636 as it stands: one review record and a prose dossier — no counters, no receipts. */
const PR_636 = [
  byMe(
    '<!-- omp-build:code-review -->\n## Code Review\n\nRound 3 (final).\n\n**Verdict: Request changes** — 1 blocking finding in 1 root cause (RC-1).',
  ),
  byMe('## Human intervention required — review did not converge\n\nThe PR applies its own rule to itself.'),
]

function mockLand({
  rollupSequence = [],
  mergeThrows = null,
  disableThrows = null,
  timeout = 60_000,
  states = ['OPEN'],
  autoMerges = [null],
  labels = [],
  /** One response per events call, last entry repeated. */
  events = EVENTS_FIRST,
  eventsThrow = null,
  /** The PR's comments, as the review gate reads them. */
  comments = APPROVED,
} = {}) {
  const t = 0
  const calls = []
  let poll = 0
  let statePoll = 0
  let eventsPoll = 0
  const eventPages = Array.isArray(events) ? events : [events]
  const gh = async (_cwd, args) => {
    calls.push(args)
    const jsonAt = args.indexOf('--json')
    const fields = jsonAt === -1 ? [] : String(args[jsonAt + 1] ?? '').split(',')
    if (same(args, IDENTITY)) return `${ME}\n`
    if (args[0] === 'pr' && args[1] === 'view' && same(fields, ['headRefOid'])) {
      return JSON.stringify({ headRefOid: APPROVED_HEAD })
    }
    if (args[0] === 'pr' && args[1] === 'view' && same(fields, ['comments'])) return JSON.stringify({ comments })
    if (args[0] === 'pr' && args[1] === 'view' && fields.includes('state')) {
      const state = states[Math.min(statePoll, states.length - 1)] ?? 'OPEN'
      const autoMergeRequest = autoMerges[Math.min(statePoll, autoMerges.length - 1)] ?? null
      statePoll++
      return JSON.stringify({ state, autoMergeRequest })
    }
    if (args[0] === 'pr' && args[1] === 'view' && fields.includes('labels')) {
      return JSON.stringify({ labels: labels.map((name) => ({ name })) })
    }
    if (args[0] === 'repo') return JSON.stringify({ nameWithOwner: 'acme/app' })
    if (args[0] === 'api' && String(args[1] ?? '').includes('/events')) {
      if (eventsThrow) throw new Error(eventsThrow)
      const page = eventPages[Math.min(eventsPoll, eventPages.length - 1)]
      eventsPoll++
      return page
    }
    if (args[0] === 'pr' && args[1] === 'view') {
      const entry = rollupSequence[Math.min(poll, rollupSequence.length - 1)]
      poll++
      return JSON.stringify(entry)
    }
    if (args[0] === 'pr' && args[1] === 'merge' && args.includes('--disable-auto')) {
      if (disableThrows) throw new Error(disableThrows)
      return ''
    }
    if (args[0] === 'pr' && args[1] === 'merge') {
      if (mergeThrows) throw new Error(mergeThrows)
      return ''
    }
    return ''
  }
  return {
    gh,
    calls,
    /** Instant sleep so retries stay in-process and fast. */
    sleep: async () => {},
    land: (requiredContexts, pr = 1) =>
      landPr(checkout(), pr, {
        requiredContexts,
        gh,
        sleep: async () => {},
        now: () => t,
        timeout,
      }),
  }
}

function labeled(calls) {
  return calls.some((a) => a[0] === 'pr' && a[1] === 'edit' && a.includes('--add-label') && a.includes('reviewed'))
}

const call = (calls, predicate) => calls.findIndex(predicate)
const removesLabel = (a) => a[1] === 'edit' && a.includes('--remove-label') && a.includes('reviewed')
const disablesAuto = (a) => a[1] === 'merge' && a.includes('--disable-auto')

describe('landPr', () => {
  it('native required=[] → no-required-checks, never labels', async () => {
    const { calls, land } = mockLand()
    const result = await land([])
    expect(result).toEqual({ status: 'no-required-checks' })
    expect(labeled(calls)).toBe(false)
  })

  it('merge-on-green with declared checks never returns no-required-checks', async () => {
    const { calls, gh, sleep } = mockLand()
    const result = await landPr('/tmp/wt', 7, {
      gh,
      sleep,
      requiredContexts: [],
      landing: { mode: 'merge-on-green', required_checks: ['ci'] },
    })
    expect(result.status).toBe('watching')
    expect(result.mode).toBe('merge-on-green')
    expect(result.watch).toContain('--merge-mode merge-on-green')
    expect(result.watch).toContain(`--since ${EVENT_AT}`)
    expect(labeled(calls)).toBe(true)
    expect(calls.some((a) => a.includes('--auto'))).toBe(false)
  })

  it('merge-on-green re-entry with reviewed on the PR removes it, then re-adds it and reads a newer labeled event', async () => {
    const { calls, gh, sleep } = mockLand({
      labels: ['reviewed'],
      events: [BEFORE_AT, `${BEFORE_AT}\n${EVENT_AT}\n`],
    })
    const result = await landPr(checkout({ '.github/workflows/merge-on-green.yml': 'name: merge-on-green\n' }), 7, {
      gh,
      sleep,
    })
    // After the review-history read: the pre-add time, remove, re-add, then the newer time.
    const historyRead = [
      IDENTITY,
      ['pr', 'view', '7', '--json', 'comments'],
      ['pr', 'view', '7', '--json', 'headRefOid'],
    ]
    expect(calls.filter((args) => !historyRead.some((read) => same(args, read)))).toEqual([
      ['repo', 'view', '--json', 'nameWithOwner'],
      EVENTS_CALL,
      ['pr', 'view', '7', '--json', 'labels'],
      ['pr', 'edit', '7', '--remove-label', 'reviewed'],
      ['pr', 'edit', '7', '--add-label', 'reviewed'],
      ['repo', 'view', '--json', 'nameWithOwner'],
      EVENTS_CALL,
    ])
    expect(result.watch).toContain(`--since ${EVENT_AT}`)
  })

  it('merge-on-green returns watch-failed when the labeled-event read fails', async () => {
    const { calls, gh, sleep } = mockLand({ eventsThrow: 'boom' })
    const result = await landPr('/tmp/wt', 7, {
      gh,
      sleep,
      landing: { mode: 'merge-on-green', required_checks: [] },
    })
    expect(result).toEqual({
      status: 'watch-failed',
      error: 'could not read the labeled reviewed event after re-label — merge-on-green needs --since from GitHub',
    })
    expect(calls.some((a) => a[0] === 'api' && String(a[1]).includes('/events'))).toBe(true)
    expect(labeled(calls)).toBe(true)
  })

  it('merge-on-green waits through a lagging events API then watches with the newer --since', async () => {
    const sleeps = []
    const { calls, gh } = mockLand({
      events: [BEFORE_AT, BEFORE_AT, BEFORE_AT, `${BEFORE_AT}\n${EVENT_AT}\n`],
    })
    const result = await landPr('/tmp/wt', 7, {
      gh,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      landing: { mode: 'merge-on-green', required_checks: [] },
    })
    expect(result).toMatchObject({ status: 'watching', mode: 'merge-on-green' })
    expect(result.watch).toContain(`--since ${EVENT_AT}`)
    expect(sleeps.length).toBeGreaterThan(0)
    expect(calls.filter((a) => a[0] === 'api' && String(a[1]).includes('/events')).length).toBe(4)
  })

  it('merge-on-green returns watch-failed when retries only ever see the pre-label time', async () => {
    const { gh, sleep } = mockLand({ events: [BEFORE_AT] })
    const result = await landPr('/tmp/wt', 7, {
      gh,
      sleep,
      landing: { mode: 'merge-on-green', required_checks: [] },
    })
    expect(result.status).toBe('watch-failed')
    expect(result.error).toMatch(/labeled reviewed event/)
  })

  it('native arms the label and auto-merge, then hands off the watch', async () => {
    const { calls, gh } = mockLand()
    const result = await landPr('/tmp/wt', 7, {
      gh,
      landing: { mode: 'native', required_checks: ['ci'] },
    })
    expect(result).toMatchObject({ status: 'watching', mode: 'native' })
    expect(result.watch).not.toContain('--since')
    expect(labeled(calls)).toBe(true)
    expect(calls.some((a) => a[1] === 'merge' && a.includes('--auto'))).toBe(true)
  })

  it('native auto-merge boom returns auto-merge-failed after arming', async () => {
    const { calls, gh } = mockLand({ mergeThrows: 'boom' })
    const result = await landPr('/tmp/wt', 7, {
      gh,
      landing: { mode: 'native', required_checks: ['ci'] },
    })
    expect(result).toEqual({ status: 'auto-merge-failed', armed: true })
    expect(labeled(calls)).toBe(true)
  })

  it('an explicit native landing still asks protection and rulesets', async () => {
    const calls = []
    const gh = async (_cwd, args) => {
      calls.push(args)
      if (same(args, IDENTITY)) return `${ME}\n`
      if (same(args, ['pr', 'view', '7', '--json', 'comments'])) return JSON.stringify({ comments: APPROVED })
      if (same(args, ['pr', 'view', '7', '--json', 'headRefOid'])) {
        return JSON.stringify({ headRefOid: APPROVED_HEAD })
      }
      if (args[0] === 'repo') return JSON.stringify({ nameWithOwner: 'acme/app' })
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ baseRefName: 'main' })
      if (args[0] === 'api') throw new Error('HTTP 403')
      return ''
    }
    const cwd = checkout({ '.github/workflows/merge-on-green.yml': 'name: merge-on-green\n' })
    const result = await landPr(cwd, 7, { gh, landing: { mode: 'native', required_checks: [] } })
    expect(result).toEqual({ status: 'no-required-checks' })
    expect(calls).toContainEqual(['api', 'repos/acme/app/branches/main/protection/required_status_checks'])
    expect(calls).toContainEqual(['api', 'repos/acme/app/rules/branches/main'])
    expect(labeled(calls)).toBe(false)
  })
})

/**
 * A PR whose gate follows the calls made on it: labels, native auto-merge, labeled events,
 * comments by author. Only exact argv is answered; anything else throws.
 */
function gatePr({ comments, labels = [], autoMerge = null, state = 'OPEN', headRefOid = null }) {
  const pr = { comments: [...comments], labels: new Set(labels), autoMerge, state, labeledAt: [], headRefOid }
  const calls = []
  const gh = async (_cwd, args) => {
    calls.push(args)
    if (same(args, IDENTITY)) return `${ME}\n`
    if (args.length === 5 && same(args.slice(0, 4), ['pr', 'view', '7', '--json'])) {
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
    if (args.length === 5 && same(args.slice(0, 4), ['pr', 'comment', '7', '--body'])) {
      pr.comments.push(byMe(args[4]))
      return ''
    }
    if (same(args, ['pr', 'edit', '7', '--remove-label', 'reviewed'])) {
      pr.labels.delete('reviewed')
      return ''
    }
    if (same(args, ['pr', 'edit', '7', '--add-label', 'reviewed'])) {
      pr.labels.add('reviewed')
      pr.labeledAt.push(EVENT_AT)
      return ''
    }
    if (same(args, ['pr', 'merge', '7', '--disable-auto'])) {
      pr.autoMerge = null
      return ''
    }
    if (same(args, ['pr', 'merge', '7', '--auto', '--merge'])) {
      pr.autoMerge = { mergeMethod: 'MERGE' }
      return ''
    }
    if (
      args.length === 7 &&
      same(args.slice(0, 5), ['pr', 'merge', '7', '--auto', '--merge']) &&
      args[5] === '--match-head-commit' &&
      args[6] === pr.headRefOid
    ) {
      pr.autoMerge = { mergeMethod: 'MERGE' }
      return ''
    }
    if (same(args, ['repo', 'view', '--json', 'nameWithOwner'])) return JSON.stringify({ nameWithOwner: 'acme/app' })
    if (same(args, EVENTS_CALL)) return pr.labeledAt.join('\n')
    throw new Error(`unexpected gh call: ${args.join(' ')}`)
  }
  return { gh, calls, pr }
}

const armsLabel = (a) => a[1] === 'edit' && a.includes('--add-label')
const enablesAuto = (a) => a[1] === 'merge' && a.includes('--auto')

const STOPPED = [
  [
    'an explicit stop, under a later green',
    [...TWO_ROUNDS, byMe(RED), byMe(accounting(3, 2, 'review-bound')), byMe(GREEN), byMe(accounting(4, 2))],
    'review-bound',
  ],
  ['a terminal red followed by a later green', [...TWO_ROUNDS, byMe(RED), byMe(GREEN)], 'review-bound'],
  ['a second allocation never receipted', TWO_ROUNDS.slice(0, 5), 'review-bound'],
  ['#636 as it stands: a review record and a prose dossier', PR_636, 'history-ambiguous'],
]

/** A gate someone armed on the PR before `landPr` ran. */
const ARMED = { labels: ['reviewed', 'size:F-lite'], autoMerge: { mergeMethod: 'MERGE' } }
/** An OPEN PR's enforced stop when every step succeeded. */
const DISARMED = {
  prState: 'OPEN',
  guaranteed: true,
  published: true,
  removed: true,
  autoMergeDisabled: true,
  disarmErrors: [],
}
const NATIVE = { landing: { mode: 'native', required_checks: ['ci'] } }

/** @param {{ calls: unknown[][], pr: { labels: Set<string>, autoMerge: unknown } }} fake */
function expectDisarmedNeverArmed(fake) {
  expect(fake.calls.some(armsLabel)).toBe(false)
  expect(fake.calls.some(enablesAuto)).toBe(false)
  expect([...fake.pr.labels]).toEqual(['size:F-lite'])
  expect(fake.pr.autoMerge).toBe(null)
}

describe('landPr — a stopped history is enforced before any landing step', () => {
  it.each(STOPPED)('%s: review-stopped, the gate disarmed, nothing armed', async (_label, comments, reason) => {
    const strict = interpretReviewHistory(comments, { me: ME })
    expect(strict.stopReason).toBe(reason)
    const fake = gatePr({ comments, ...ARMED })
    const result = await landPr('/tmp/wt', 7, { gh: fake.gh, ...NATIVE })
    expect(result).toMatchObject({
      status: 'review-stopped',
      reason,
      reviews: strict.reviews,
      fixes: strict.fixes,
      stop: DISARMED,
    })
    expectDisarmedNeverArmed(fake)
    expect(interpretReviewHistory(fake.pr.comments, { me: ME }).stopReason).toBe(reason)
  })

  it.each([
    ['native with zero required contexts', { landing: { mode: 'native', required_checks: [] }, requiredContexts: [] }],
    ['merge-on-green', { landing: { mode: 'merge-on-green', required_checks: [] } }],
  ])('%s: the stop comes first, the gate disarmed, nothing armed', async (_mode, options) => {
    const fake = gatePr({ comments: PR_636, ...ARMED })
    const result = await landPr('/tmp/wt', 7, { gh: fake.gh, sleep: async () => {}, ...options })
    expect(result).toMatchObject({ status: 'review-stopped', reason: 'history-ambiguous', stop: DISARMED })
    expectDisarmedNeverArmed(fake)
  })
})

describe('landPr — only an approval of the latest correction arms', () => {
  it.each([
    ['no review record at all', [], { reviews: 0, fixes: 0 }],
    [
      'a first red whose allocation is not persisted yet',
      [byMe(accounting(0, 0)), byMe(RED)],
      { reviews: 1, fixes: 0 },
    ],
    [
      'a newer red after the green',
      [byMe(GREEN), byMe(accounting(1, 0)), byMe(RED), byMe(accounting(2, 1))],
      { reviews: 2, fixes: 1 },
    ],
    [
      'a fix receipted but not re-reviewed',
      [byMe(RED), byMe(accounting(1, 1)), byMe(RECEIPT)],
      { reviews: 1, fixes: 1 },
    ],
    [
      'a correction receipted after the approval',
      [byMe(RED), byMe(accounting(1, 1)), byMe(GREEN), byMe(accounting(2, 1)), byMe(RECEIPT)],
      { reviews: 2, fixes: 1 },
    ],
    [
      'a CI-fix allocation after the approval, not yet re-reviewed',
      [byMe(RED), byMe(accounting(1, 1)), byMe(RECEIPT), byMe(GREEN), byMe(accounting(2, 1)), byMe(accounting(2, 2))],
      { reviews: 2, fixes: 2 },
    ],
    [
      'an approval posted by another account',
      [byMe(RED), byMe(accounting(1, 1)), byMe(RECEIPT), { author: { login: 'attacker' }, body: GREEN }],
      { reviews: 1, fixes: 1 },
    ],
  ])('%s: not-approved, and no gate write', async (_label, comments, counts) => {
    const fake = gatePr({ comments })
    const result = await landPr('/tmp/wt', 7, { gh: fake.gh, ...NATIVE })
    expect(result).toEqual({ status: 'not-approved', ...counts })
    expect(fake.calls.some((args) => args[1] === 'edit' || args[1] === 'merge' || args[1] === 'comment')).toBe(false)
    expect(fake.pr.labels.size).toBe(0)
    expect(fake.pr.autoMerge).toBe(null)
  })

  it.each(['Approve', 'Approve with comments'])('arms on an %s verdict as well', async (verdict) => {
    const fake = gatePr({
      comments: [byMe(boundReview(verdict, REVIEWED_HEAD)), byMe(accounting(1, 0))],
      headRefOid: REVIEWED_HEAD,
    })
    const result = await landPr('/tmp/wt', 7, { gh: fake.gh, ...NATIVE })
    expect(result).toMatchObject({ status: 'watching', mode: 'native' })
    expect(fake.pr.labels.has('reviewed')).toBe(true)
  })
})

describe('landPr — a green history after spent rounds still lands in both modes', () => {
  const LANDABLE = [
    [
      'a final green after two fixes',
      [...TWO_ROUNDS, byMe(boundReview('Approve (clean)', REVIEWED_HEAD)), byMe(accounting(3, 2))],
    ],
    [
      'legacy receipts for two fixes, then a green, no counters',
      [byMe(RED), byMe(RECEIPT), byMe(RED), byMe(RECEIPT), byMe(boundReview('Approve (clean)', REVIEWED_HEAD))],
    ],
  ]

  it.each(LANDABLE)('native: %s arms the label and auto-merge', async (_label, comments) => {
    const fake = gatePr({ comments, headRefOid: REVIEWED_HEAD })
    const result = await landPr('/tmp/wt', 7, { gh: fake.gh, landing: { mode: 'native', required_checks: ['ci'] } })
    expect(result).toMatchObject({ status: 'watching', mode: 'native' })
    expect(fake.pr.labels.has('reviewed')).toBe(true)
    expect(fake.pr.autoMerge).not.toBe(null)
    expect(fake.pr.comments).toEqual(comments)
  })

  it.each(LANDABLE)('merge-on-green: %s arms the label and watches from its event', async (_label, comments) => {
    const fake = gatePr({ comments, headRefOid: REVIEWED_HEAD })
    const result = await landPr('/tmp/wt', 7, {
      gh: fake.gh,
      sleep: async () => {},
      landing: { mode: 'merge-on-green', required_checks: [] },
    })
    expect(result).toMatchObject({ status: 'watching', mode: 'merge-on-green' })
    expect(result.watch).toContain(`--since ${EVENT_AT}`)
    expect(fake.pr.labels.has('reviewed')).toBe(true)
    expect(fake.pr.autoMerge).toBe(null)
  })
})

describe('landPr — an unreadable review history never arms', () => {
  const COMMENTS = ['pr', 'view', '7', '--json', 'comments']

  it.each([
    ['a JSON-shaped identity', IDENTITY, '{"login":"omp-bot"}'],
    ['an empty identity', IDENTITY, ''],
    ['comments that are not JSON', COMMENTS, 'gh: could not find pull request'],
    ['a response carrying no comments', COMMENTS, JSON.stringify({ labels: [] })],
    ['a failed comments read', COMMENTS, new Error('HTTP 502')],
  ])('%s rejects before any gate write', async (_label, query, answer) => {
    const fake = gatePr({ comments: APPROVED })
    const gh = async (cwd, args) => {
      if (!same(args, query)) return fake.gh(cwd, args)
      if (answer instanceof Error) throw answer
      return answer
    }
    await expect(landPr('/tmp/wt', 7, { gh, landing: { mode: 'native', required_checks: ['ci'] } })).rejects.toThrow()
    expect(fake.calls.some((args) => args[1] === 'edit' || args[1] === 'merge' || args[1] === 'comment')).toBe(false)
    expect(fake.pr.labels.size).toBe(0)
  })
})

describe('applyCiWatchExit', () => {
  const view = ['pr', 'view', '7', '--json', 'state,autoMergeRequest']

  it.each([
    [4, 'stopped'],
    [5, 'timeout'],
  ])('exit %s → %s', async (code, status) => {
    const { gh, calls } = mockLand()
    expect(await applyCiWatchExit('/tmp/wt', 7, code, { mode: 'merge-on-green', gh })).toEqual({ status })
    expect(calls).toEqual([])
  })

  it('exit 6 is evaluate-only and leaves the gate armed', async () => {
    const { gh, calls } = mockLand()
    expect(await applyCiWatchExit('/tmp/wt', 7, 6, { mode: 'merge-on-green', gh })).toEqual({
      status: 'evaluate-only',
    })
    expect(calls).toEqual([])
  })

  it('exit 0 on a merged PR is merged', async () => {
    const { gh, calls } = mockLand({ states: ['MERGED'] })
    expect(await applyCiWatchExit('/tmp/wt', 7, 0, { mode: 'native', gh })).toEqual({ status: 'merged' })
    expect(calls).toEqual([view])
  })

  it('exit 0 on an unmerged PR is stopped', async () => {
    const { gh, calls } = mockLand({ states: ['OPEN'] })
    expect(await applyCiWatchExit('/tmp/wt', 7, 0, { mode: 'native', gh })).toEqual({ status: 'stopped' })
    expect(calls).toEqual([view])
  })

  it.each([1, 2, 3])('exit %s on a closed PR is stopped without disarm', async (code) => {
    const { gh, calls } = mockLand({ states: ['CLOSED'] })
    expect(await applyCiWatchExit('/tmp/wt', 7, code, { mode: 'native', gh })).toEqual({ status: 'stopped' })
    expect(calls).toEqual([view])
  })

  it('exit 1 on merge-on-green removes reviewed and does not disable auto-merge', async () => {
    const { gh, calls } = mockLand()
    expect(await applyCiWatchExit('/tmp/wt', 7, 1, { mode: 'merge-on-green', gh })).toEqual({
      status: 'ci-failed',
      disarmed: true,
    })
    expect(calls.some(removesLabel)).toBe(true)
    expect(calls.some(disablesAuto)).toBe(false)
  })

  it('exit 1 on native removes the label before disabling auto-merge', async () => {
    const { gh, calls } = mockLand()
    expect(await applyCiWatchExit('/tmp/wt', 7, 1, { mode: 'native', gh })).toEqual({
      status: 'ci-failed',
      disarmed: true,
    })
    expect(call(calls, disablesAuto)).toBeGreaterThan(call(calls, removesLabel))
  })

  it.each([
    [2, 'ci-cancelled'],
    [3, 'ci-blocked'],
  ])('exit %s on merge-on-green disarms reviewed only → %s', async (code, status) => {
    const { gh, calls } = mockLand()
    expect(await applyCiWatchExit('/tmp/wt', 7, code, { mode: 'merge-on-green', gh })).toEqual({
      status,
      disarmed: true,
    })
    expect(calls).toEqual([
      ['pr', 'view', '7', '--json', 'state,autoMergeRequest'],
      ['pr', 'edit', '7', '--remove-label', 'reviewed'],
    ])
  })

  it.each([
    [2, 'ci-cancelled'],
    [3, 'ci-blocked'],
  ])('exit %s on native removes the label then disables auto-merge → %s', async (code, status) => {
    const { gh, calls } = mockLand()
    expect(await applyCiWatchExit('/tmp/wt', 7, code, { mode: 'native', gh })).toEqual({
      status,
      disarmed: true,
    })
    expect(calls).toEqual([
      ['pr', 'view', '7', '--json', 'state,autoMergeRequest'],
      ['pr', 'edit', '7', '--remove-label', 'reviewed'],
      ['pr', 'merge', '7', '--disable-auto'],
    ])
  })

  it('an unmapped exit leaves the gate armed', async () => {
    const { gh, calls } = mockLand()
    expect(await applyCiWatchExit('/tmp/wt', 7, 9, { mode: 'native', gh })).toEqual({
      status: 'watch-failed',
      code: 9,
    })
    expect(calls).toEqual([])
  })

  it('a merged PR is not disarmed', async () => {
    const { gh, calls } = mockLand({ states: ['MERGED'] })
    expect(await applyCiWatchExit('/tmp/wt', 7, 3, { mode: 'native', gh })).toEqual({ status: 'merged' })
    expect(calls).toEqual([['pr', 'view', '7', '--json', 'state,autoMergeRequest']])
  })

  it('a merge that wins during disable-auto is merged', async () => {
    const { gh, calls } = mockLand({ disableThrows: 'already merged', states: ['OPEN', 'MERGED'] })
    expect(await applyCiWatchExit('/tmp/wt', 7, 1, { mode: 'native', gh })).toEqual({ status: 'merged' })
    expect(calls).toEqual([
      ['pr', 'view', '7', '--json', 'state,autoMergeRequest'],
      ['pr', 'edit', '7', '--remove-label', 'reviewed'],
      ['pr', 'merge', '7', '--disable-auto'],
      ['pr', 'view', '7', '--json', 'state,autoMergeRequest'],
    ])
  })

  it('a disable-auto error with no auto-merge is already disarmed', async () => {
    const { gh, calls } = mockLand({ disableThrows: 'already off', states: ['OPEN', 'OPEN'] })
    expect(await applyCiWatchExit('/tmp/wt', 7, 2, { mode: 'native', gh })).toEqual({
      status: 'ci-cancelled',
      disarmed: true,
    })
    expect(calls).toEqual([
      ['pr', 'view', '7', '--json', 'state,autoMergeRequest'],
      ['pr', 'edit', '7', '--remove-label', 'reviewed'],
      ['pr', 'merge', '7', '--disable-auto'],
      ['pr', 'view', '7', '--json', 'state,autoMergeRequest'],
    ])
  })

  it('rethrown disable-auto failure when auto-merge is still set', async () => {
    const { gh } = mockLand({
      disableThrows: 'nope',
      states: ['OPEN', 'OPEN'],
      autoMerges: [null, { enabledAt: 't' }],
    })
    await expect(applyCiWatchExit('/tmp/wt', 7, 1, { mode: 'native', gh })).rejects.toThrow(/nope/)
  })

  it('exit 70 leaves the gate armed', async () => {
    const { gh, calls } = mockLand()
    expect(await applyCiWatchExit('/tmp/wt', 7, 70, { mode: 'native', gh })).toEqual({
      status: 'watch-failed',
      code: 70,
    })
    expect(calls).toEqual([])
  })
})

describe('disarmReviewedBeforePush', () => {
  it('removes reviewed before the push that follows it', async () => {
    const { gh, calls } = mockLand()
    let removedBeforePush = false
    await disarmReviewedBeforePush('/tmp/wt', 7, {
      gh,
      push: async () => {
        removedBeforePush = calls.some(removesLabel)
      },
    })
    expect(removedBeforePush).toBe(true)
  })
})

const REVIEWED_HEAD = '0123456789abcdef0123456789abcdef01234567'
const MOVED_HEAD = 'fedcba9876543210fedcba9876543210fedcba98'
/** Line 2 of a review record, the only place a reviewed commit is read. @param {string} sha */
const headLine = (sha) => `<!-- omp-build:review-head sha=${sha} -->`
/** @param {string} verdict @param {string} sha */
const boundReview = (verdict, sha) =>
  `<!-- omp-build:code-review -->\n${headLine(sha)}\n## Code Review\n\n**Verdict: ${verdict}** — summary`
const noWrite = (calls) => calls.some((args) => args[1] === 'edit' || args[1] === 'merge' || args[1] === 'comment')

describe('landPr — an approval arms only the commit it reviewed', () => {
  it('a push after an approving review is not-approved and writes nothing', async () => {
    const fake = gatePr({
      comments: [byMe(boundReview('Approve (clean)', REVIEWED_HEAD)), byMe(accounting(1, 0))],
      headRefOid: MOVED_HEAD,
    })
    const result = await landPr('/tmp/wt', 7, { gh: fake.gh, ...NATIVE })
    expect(result).toEqual({ status: 'not-approved', reviews: 1, fixes: 0, reason: 'head-moved' })
    expect(noWrite(fake.calls)).toBe(false)
  })

  it('an unreadable current head is head-moved, not an approval of nothing', async () => {
    const fake = gatePr({
      comments: [byMe(boundReview('Approve (clean)', REVIEWED_HEAD)), byMe(accounting(1, 0))],
      headRefOid: null,
    })
    const result = await landPr('/tmp/wt', 7, { gh: fake.gh, ...NATIVE })
    expect(result).toEqual({ status: 'not-approved', reviews: 1, fixes: 0, reason: 'head-moved' })
    expect(noWrite(fake.calls)).toBe(false)
  })

  it('a review record with no head line does not arm', async () => {
    const fake = gatePr({ comments: [byMe(GREEN), byMe(accounting(1, 0))], headRefOid: REVIEWED_HEAD })
    const result = await landPr('/tmp/wt', 7, { gh: fake.gh, ...NATIVE })
    expect(result).toEqual({ status: 'not-approved', reviews: 1, fixes: 0, reason: 'no-review-head' })
    expect(noWrite(fake.calls)).toBe(false)
  })

  it('a missing head oid beside a record with no head line does not arm', async () => {
    const fake = gatePr({ comments: [byMe(GREEN), byMe(accounting(1, 0))], headRefOid: null })
    const result = await landPr('/tmp/wt', 7, { gh: fake.gh, ...NATIVE })
    expect(result).toEqual({ status: 'not-approved', reviews: 1, fixes: 0, reason: 'no-review-head' })
    expect(noWrite(fake.calls)).toBe(false)
  })

  it('a head marker quoted in the findings, with line 2 absent, does not arm', async () => {
    const quoted = `<!-- omp-build:code-review -->\n## Code Review\n\n${headLine(REVIEWED_HEAD)}\n\n**Verdict: Approve (clean)** — summary`
    const fake = gatePr({ comments: [byMe(quoted), byMe(accounting(1, 0))], headRefOid: REVIEWED_HEAD })
    const result = await landPr('/tmp/wt', 7, { gh: fake.gh, ...NATIVE })
    expect(result).toEqual({ status: 'not-approved', reviews: 1, fixes: 0, reason: 'no-review-head' })
    expect(noWrite(fake.calls)).toBe(false)
  })

  it('an approving review of the current head arms, and native auto-merge is pinned to that commit', async () => {
    const fake = gatePr({
      comments: [byMe(boundReview('Approve (clean)', REVIEWED_HEAD)), byMe(accounting(1, 0))],
      headRefOid: REVIEWED_HEAD,
    })
    const result = await landPr('/tmp/wt', 7, { gh: fake.gh, ...NATIVE })
    expect(result).toMatchObject({ status: 'watching', mode: 'native' })
    expect(fake.calls).toContainEqual(['pr', 'merge', '7', '--auto', '--merge', '--match-head-commit', REVIEWED_HEAD])
    expect(fake.pr.labels.has('reviewed')).toBe(true)
  })

  it('exposes the reviewed head of the latest record, null when line 2 is absent or malformed', async () => {
    const { analyzeReviewHistory } = await import('./workflow.js')
    const parsed = analyzeReviewHistory(
      [byMe(boundReview('Approve', REVIEWED_HEAD)), byMe(boundReview('Request changes', MOVED_HEAD))],
      { me: ME },
    )
    expect(parsed.reviewedHead).toBe(MOVED_HEAD)
    expect(analyzeReviewHistory([byMe(GREEN)], { me: ME }).reviewedHead).toBe(null)
    expect(
      analyzeReviewHistory([byMe(boundReview('Approve', REVIEWED_HEAD.toUpperCase()))], { me: ME }).reviewedHead,
    ).toBe(null)
  })
})
