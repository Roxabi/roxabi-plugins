import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  applyCiWatchExit,
  commentPageArgs,
  disarmReviewedBeforePush,
  landPr,
  parseRequiredContexts,
} from './workflow.js'

/** A checkout with the given files, relative path → content. Base-ref landing is covered in land.integration.test.js. */
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
/** The fields of the one gate read `landPr` makes before deciding. */
const GATE_FIELDS = 'headRefOid,state,labels,autoMergeRequest'
/** @param {number} pr */
const GATE_READ = (pr) => ['pr', 'view', String(pr), '--json', GATE_FIELDS]
/** @param {unknown[]} args @param {unknown[]} expected */
const same = (args, expected) => args.length === expected.length && expected.every((arg, i) => args[i] === arg)
const REVIEWED_HEAD = '0123456789abcdef0123456789abcdef01234567'
const MOVED_HEAD = 'fedcba9876543210fedcba9876543210fedcba98'
/** @param {string} body */
const byMe = (body) => ({ author: { login: ME }, body })
/** Line 2 of a review record, the only place a reviewed commit is read. @param {string} sha */
const headLine = (sha) => `<!-- omp-build:review-head sha=${sha} -->`
/** A review record as dev-review posts it: marker, head line, verdict last. @param {string} verdict @param {string} sha */
const boundReview = (verdict, sha) =>
  `<!-- omp-build:code-review -->\n${headLine(sha)}\n## Code Review\n\n**Verdict: ${verdict}** — summary`
/** A review record with no head line. @param {string} verdict */
const review = (verdict) => `<!-- omp-build:code-review -->\n## Code Review\n\n**Verdict: ${verdict}** — summary`
const GREEN = review('Approve (clean)')
/** A record whose verdict lines conflict: no verdict at all. */
const NULL_VERDICT = `${boundReview('Approve', REVIEWED_HEAD)}\n**Verdict: Request changes**`
const red = (head = REVIEWED_HEAD) => byMe(boundReview('Request changes', head))
const green = (head = REVIEWED_HEAD) => byMe(boundReview('Approve (clean)', head))
const noWrite = (calls) => calls.some((args) => args[1] === 'edit' || args[1] === 'merge' || args[1] === 'comment')
/** A first-round approval of a named commit. */
const APPROVED = [green()]

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
  let eventsPoll = 0
  const eventPages = Array.isArray(events) ? events : [events]
  const gateLabels = new Set(labels)
  let gateAuto = autoMerges[0] ?? null
  let gateState = states[0] ?? 'OPEN'
  const gh = async (_cwd, args) => {
    calls.push(args)
    const jsonAt = args.indexOf('--json')
    const fields = jsonAt === -1 ? [] : String(args[jsonAt + 1] ?? '').split(',')
    if (same(args, IDENTITY)) return `${ME}\n`
    if (
      args[0] === 'api' &&
      args[1] === '--paginate' &&
      args[2] === '--slurp' &&
      String(args[3]).endsWith('/comments')
    ) {
      return JSON.stringify([
        comments.map((entry, index) => ({
          user: { login: entry.author.login },
          body: entry.body,
          created_at: `2026-01-01T00:00:${String(index).padStart(2, '0')}Z`,
        })),
      ])
    }
    if (args[0] === 'pr' && args[1] === 'view' && args[jsonAt + 1] === GATE_FIELDS) {
      return JSON.stringify({
        headRefOid: REVIEWED_HEAD,
        state: gateState,
        labels: [...gateLabels].map((name) => ({ name })),
        autoMergeRequest: gateAuto,
      })
    }
    if (args[0] === 'pr' && args[1] === 'view' && same(fields, ['baseRefName'])) {
      return JSON.stringify({ baseRefName: 'main' })
    }
    if (args[0] === 'pr' && args[1] === 'view' && same(fields, ['headRefOid'])) {
      return JSON.stringify({ headRefOid: REVIEWED_HEAD })
    }
    if (args[0] === 'pr' && args[1] === 'view' && fields.includes('state')) {
      return JSON.stringify({ state: gateState, autoMergeRequest: gateAuto })
    }
    if (args[0] === 'pr' && args[1] === 'view' && fields.includes('labels')) {
      return JSON.stringify({ labels: [...gateLabels].map((name) => ({ name })) })
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
    if (args[0] === 'pr' && args[1] === 'edit' && args.includes('--remove-label') && args.includes('reviewed')) {
      gateLabels.delete('reviewed')
      return ''
    }
    if (args[0] === 'pr' && args[1] === 'edit' && args.includes('--add-label') && args.includes('reviewed')) {
      gateLabels.add('reviewed')
      return ''
    }
    if (args[0] === 'pr' && args[1] === 'merge' && args.includes('--disable-auto')) {
      if (disableThrows) {
        if (/already off/.test(String(disableThrows))) gateAuto = null
        if (/already merged/.test(String(disableThrows))) gateState = 'MERGED'
        throw new Error(disableThrows)
      }
      gateAuto = null
      return ''
    }
    if (args[0] === 'pr' && args[1] === 'merge') {
      if (mergeThrows) throw new Error(mergeThrows)
      if (args.includes('--auto')) gateAuto = { mergeMethod: 'MERGE' }
      return ''
    }
    return ''
  }
  return {
    gh,
    calls,
    gate: {
      get state() {
        return gateState
      },
      get labels() {
        return [...gateLabels]
      },
      get autoMerge() {
        return gateAuto
      },
    },
    /** Instant sleep so retries stay in-process and fast. */
    sleep: async () => {},
    land: (requiredContexts, pr = 1) =>
      landPr(checkout(), pr, {
        requiredContexts,
        // Unit tests inject landing so readLanding (git) is never forked here (#502).
        landing: { mode: 'native', required_checks: requiredContexts ?? [] },
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
    const result = await landPr('/tmp/wt', 7, {
      gh,
      sleep,
      landing: { mode: 'merge-on-green', required_checks: [] },
    })
    // After the review-history and gate reads: the pre-add time, remove, re-add, then the newer time.
    const historyRead = [IDENTITY, commentPageArgs(7), GATE_READ(7), ['pr', 'view', '7', '--json', 'headRefOid']]
    expect(calls.filter((args) => !historyRead.some((read) => same(args, read)))).toEqual([
      ['pr', 'view', '7', '--json', 'baseRefName'],
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

  it('native auto-merge boom returns auto-merge-failed without the label', async () => {
    const { calls, gh } = mockLand({ mergeThrows: 'boom' })
    const result = await landPr('/tmp/wt', 7, {
      gh,
      landing: { mode: 'native', required_checks: ['ci'] },
    })
    expect(result).toEqual({ status: 'auto-merge-failed', armed: false })
    expect(labeled(calls)).toBe(false)
  })

  it('an explicit native landing still asks protection and rulesets', async () => {
    const calls = []
    const gh = async (_cwd, args) => {
      calls.push(args)
      if (same(args, IDENTITY)) return `${ME}\n`
      if (same(args, commentPageArgs(7)))
        return JSON.stringify([
          APPROVED.map((entry) => ({
            user: { login: entry.author.login },
            body: entry.body,
            created_at: '2026-01-01T00:00:00Z',
          })),
        ])
      if (same(args, GATE_READ(7))) {
        return JSON.stringify({ headRefOid: REVIEWED_HEAD, state: 'OPEN', labels: [], autoMergeRequest: null })
      }
      if (same(args, ['pr', 'view', '7', '--json', 'headRefOid'])) {
        return JSON.stringify({ headRefOid: REVIEWED_HEAD })
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
    if (
      args[0] === 'api' &&
      args[1] === '--paginate' &&
      args[2] === '--slurp' &&
      String(args[3]).endsWith('/comments')
    ) {
      return JSON.stringify([
        pr.comments.map((entry, index) => ({
          user: { login: entry.author.login },
          body: entry.body,
          created_at: `2026-01-01T00:00:${String(index).padStart(2, '0')}Z`,
        })),
      ])
    }
    if (args.length === 5 && same(args.slice(0, 4), ['pr', 'view', '7', '--json'])) {
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

/** A gate someone armed on the PR before `landPr` ran. */
const ARMED = { labels: ['reviewed', 'size:F-lite'], autoMerge: { mergeMethod: 'MERGE' } }
const NATIVE = { landing: { mode: 'native', required_checks: ['ci'] } }

describe('landPr — a spent review bound is enforced before any landing step', () => {
  const SPENT = [
    ['three reds, then an approval of the current head', [red(), red(), red(), green()], 3],
    ['three reds, a conflicting record, then an approval', [red(), red(), red(), byMe(NULL_VERDICT), green()], 3],
  ]
  const MODES = [
    ['native', NATIVE],
    ['native with zero required contexts', { landing: { mode: 'native', required_checks: [] }, requiredContexts: [] }],
    ['merge-on-green', { landing: { mode: 'merge-on-green', required_checks: [] } }],
  ]
  const CASES = SPENT.flatMap(([label, comments, reviews]) =>
    MODES.map(([mode, options]) => [`${label}, under ${mode}`, comments, reviews, options]),
  )

  it.each(CASES)(
    '%s: not-approved by the review bound, and the armed gate is disarmed',
    async (_label, comments, reviews, options) => {
      const fake = gatePr({ comments, headRefOid: REVIEWED_HEAD, ...ARMED })
      const result = await landPr('/tmp/wt', 7, { gh: fake.gh, sleep: async () => {}, ...options })
      expect(result).toEqual({ status: 'not-approved', reviews, reason: 'review-bound', disarmed: true })
      expect([...fake.pr.labels]).toEqual(['size:F-lite'])
      expect(fake.pr.autoMerge).toBe(null)
      expect(fake.calls.some(armsLabel)).toBe(false)
      expect(fake.calls.some((args) => args[1] === 'merge' && args.includes('--auto'))).toBe(false)
    },
  )

  it('does not spend the bound on a conflicting record or on approvals', async () => {
    const fake = gatePr({
      comments: [red(), red(), byMe(NULL_VERDICT), green(), green()],
      headRefOid: REVIEWED_HEAD,
      ...ARMED,
    })
    const result = await landPr('/tmp/wt', 7, { gh: fake.gh, ...NATIVE })
    expect(result.status).toBe('watching')
  })
})

describe('landPr — a refusal disarms a gate armed for an earlier approval', () => {
  it.each([
    ['a red review after the approval, at the same head', [green(), red()], REVIEWED_HEAD, undefined, 1],
    ['a push after the approval', [green()], MOVED_HEAD, 'head-moved', 0],
    ['an approval with no head line', [byMe(GREEN)], REVIEWED_HEAD, 'no-review-head', 0],
  ])(
    '%s: not-approved, reviewed removed and auto-merge disabled',
    async (_label, comments, headRefOid, reason, reviews) => {
      const fake = gatePr({ comments, headRefOid, ...ARMED })
      const result = await landPr('/tmp/wt', 7, { gh: fake.gh, ...NATIVE })
      expect(result).toEqual({
        status: 'not-approved',
        reviews,
        ...(reason && { reason }),
        disarmed: true,
      })
      expect([...fake.pr.labels]).toEqual(['size:F-lite'])
      expect(fake.pr.autoMerge).toBe(null)
      expect(fake.calls.some(armsLabel)).toBe(false)
    },
  )

  it.each([
    ['native', NATIVE],
    ['merge-on-green', { landing: { mode: 'merge-on-green', required_checks: [] } }],
  ])(
    'a head that moves at the first pre-write re-read under %s: not-approved, and the armed gate is disarmed',
    async (_mode, options) => {
      const fake = gatePr({ comments: [green()], headRefOid: REVIEWED_HEAD, ...ARMED })
      const gh = async (cwd, args) => {
        if (same(args, ['pr', 'view', '7', '--json', 'headRefOid'])) fake.pr.headRefOid = MOVED_HEAD
        return fake.gh(cwd, args)
      }
      const result = await landPr('/tmp/wt', 7, { gh, sleep: async () => {}, ...options })
      expect(result).toEqual({ status: 'not-approved', reviews: 0, reason: 'head-moved', disarmed: true })
      expect([...fake.pr.labels]).toEqual(['size:F-lite'])
      expect(fake.pr.autoMerge).toBe(null)
      expect(fake.calls.some(armsLabel)).toBe(false)
    },
  )

  it('leaves the gate of a CLOSED PR alone', async () => {
    const fake = gatePr({ comments: [green(), red()], headRefOid: REVIEWED_HEAD, state: 'CLOSED', ...ARMED })
    const result = await landPr('/tmp/wt', 7, { gh: fake.gh, ...NATIVE })
    expect(result).toEqual({ status: 'not-approved', reviews: 1 })
    expect(noWrite(fake.calls)).toBe(false)
  })
})

describe('landPr — only an approving latest record arms', () => {
  it.each([
    ['no review record at all', [], 0],
    ['a red latest record at the current head', [red()], 1],
    ['a red after the approval, both at the current head', [green(), red()], 1],
    ['a latest record with conflicting verdicts', [byMe(NULL_VERDICT)], 0],
    [
      'an approval posted by another account',
      [red(), { author: { login: 'attacker' }, body: boundReview('Approve (clean)', REVIEWED_HEAD) }],
      1,
    ],
  ])('%s: not-approved, and no gate write', async (_label, comments, reviews) => {
    const fake = gatePr({ comments, headRefOid: REVIEWED_HEAD })
    const result = await landPr('/tmp/wt', 7, { gh: fake.gh, ...NATIVE })
    expect(result).toEqual({ status: 'not-approved', reviews })
    expect(noWrite(fake.calls)).toBe(false)
    expect(fake.pr.labels.size).toBe(0)
    expect(fake.pr.autoMerge).toBe(null)
  })

  it.each(['Approve', 'Approve with comments'])('arms on an %s verdict as well', async (verdict) => {
    const fake = gatePr({
      comments: [byMe(boundReview(verdict, REVIEWED_HEAD))],
      headRefOid: REVIEWED_HEAD,
    })
    const result = await landPr('/tmp/wt', 7, { gh: fake.gh, ...NATIVE })
    expect(result).toMatchObject({ status: 'watching', mode: 'native' })
    expect(fake.pr.labels.has('reviewed')).toBe(true)
  })
})

describe('landPr — a green record within the bound still lands in both modes', () => {
  const LANDABLE = [
    ['a red, a red, then an approval of the current head', [red(MOVED_HEAD), red(MOVED_HEAD), green()]],
    ['a red, then an approval of the current head', [red(MOVED_HEAD), green()]],
  ]

  it.each(LANDABLE)('native: %s arms the label and auto-merge', async (_label, comments) => {
    const fake = gatePr({ comments, headRefOid: REVIEWED_HEAD })
    const result = await landPr('/tmp/wt', 7, { gh: fake.gh, ...NATIVE })
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

describe('landPr — retired ledger markers are inert', () => {
  /** By the automation login, after the last review record; one carries an Approve and a valid head line. */
  const LEGACY = [
    byMe('<!-- omp-build:review-rounds reviews=9 fixes=9 -->\nReview bound: 9 review(s), 9 of 2 fix round(s) spent.'),
    byMe('<!-- omp-build:review-stop reason=review-bound -->'),
    byMe('<!-- omp-build:fix-grant reviews=1 fixes=1 token=0123456789abcdef -->'),
    byMe(`## Review Fixes Applied\n${headLine(REVIEWED_HEAD)}\n\n**Verdict: Approve**`),
  ]
  const attempt = async (comments) => {
    const fake = gatePr({ comments, headRefOid: REVIEWED_HEAD })
    const result = await landPr('/tmp/wt', 7, { gh: fake.gh, ...NATIVE })
    return { result, labels: [...fake.pr.labels], autoMerge: fake.pr.autoMerge, wrote: noWrite(fake.calls) }
  }

  it.each([
    ['an approving history', [green()], { status: 'watching', mode: 'native' }],
    ['a red latest record', [red()], { status: 'not-approved', reviews: 1 }],
    ['a spent history', [red(), red(), red()], { status: 'not-approved', reviews: 3, reason: 'review-bound' }],
  ])('%s lands identically with the markers after its last record', async (_label, records, expected) => {
    const plain = await attempt(records)
    expect(plain.result).toMatchObject(expected)
    expect(await attempt([...records, ...LEGACY])).toEqual(plain)
  })
})

describe('landPr — an unreadable review history never arms', () => {
  const COMMENTS = commentPageArgs(7)

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

describe('applyCiWatchExit — public status and gate state', () => {
  const OBSERVERS = [
    [0, { status: 'stopped' }],
    [4, { status: 'stopped' }],
    [5, { status: 'timeout' }],
    [6, { status: 'evaluate-only' }],
    [70, { status: 'watch-failed', code: 70 }],
    [9, { status: 'watch-failed', code: 9 }],
  ]

  it.each(OBSERVERS)('exit %s preserves a valid approval without claiming a disarm', async (code, expected) => {
    const fake = gatePr({ comments: [green()], headRefOid: REVIEWED_HEAD, ...ARMED })
    const result = await applyCiWatchExit('/tmp/wt', 7, code, { gh: fake.gh })
    expect(result).toEqual(expected)
    expect([...fake.pr.labels]).toEqual(ARMED.labels)
    expect(fake.pr.autoMerge).toEqual(ARMED.autoMerge)
  })

  it.each([1, 2, 3])('exit %s forces unarmed even when review records cannot be acquired', async (code) => {
    const fake = gatePr({ comments: [green()], headRefOid: REVIEWED_HEAD, ...ARMED })
    const gh = async (cwd, args) => {
      if (same(args, IDENTITY) || same(args, commentPageArgs(7))) throw new Error('review service unavailable')
      return fake.gh(cwd, args)
    }
    const result = await applyCiWatchExit('/tmp/wt', 7, code, { gh })
    expect(result).toEqual({ status: { 1: 'ci-failed', 2: 'ci-cancelled', 3: 'ci-blocked' }[code], disarmed: true })
    expect([...fake.pr.labels]).toEqual(['size:F-lite'])
    expect(fake.pr.autoMerge).toBe(null)
  })

  it('a merge that wins during disable-auto is merged, not a disarm claim', async () => {
    const { gh, gate } = mockLand({
      disableThrows: 'already merged',
      labels: ['reviewed'],
      autoMerges: [{ enabledAt: 't' }],
    })
    expect(await applyCiWatchExit('/tmp/wt', 7, 1, { gh })).toEqual({ status: 'merged' })
    expect(gate.state).toBe('MERGED')
  })
})

describe('disarmReviewedBeforePush — callback barrier', () => {
  it.each(['both', 'label', 'auto', 'none'])('%s is clear before the callback, which runs once', async (start) => {
    const fake = gatePr({
      comments: [green()],
      headRefOid: REVIEWED_HEAD,
      labels: ['size:F-lite', ...(['both', 'label'].includes(start) ? ['reviewed'] : [])],
      autoMerge: ['both', 'auto'].includes(start) ? { mergeMethod: 'MERGE' } : null,
    })
    let pushes = 0
    const result = await disarmReviewedBeforePush('/tmp/wt', 7, {
      gh: fake.gh,
      push: () => {
        pushes++
        expect([...fake.pr.labels]).toEqual(['size:F-lite'])
        expect(fake.pr.autoMerge).toBe(null)
        fake.pr.headRefOid = MOVED_HEAD
      },
    })
    expect(result).toEqual(start === 'none' ? {} : { disarmed: true })
    expect(pushes).toBe(1)
    expect(fake.pr.headRefOid).toBe(MOVED_HEAD)
  })

  it.each(['sync', 'async'])('preserves the original %s callback error without retrying cleanup', async (kind) => {
    const fake = gatePr({ comments: [green()], headRefOid: REVIEWED_HEAD, ...ARMED })
    const original = new Error(`${kind} push failed`)
    let pushes = 0
    let callbackEntered = false
    const gh = async (cwd, args) => {
      if (callbackEntered) throw new Error('cleanup attempted after callback')
      return fake.gh(cwd, args)
    }
    const fail = () => {
      pushes++
      callbackEntered = true
      fake.pr.headRefOid = MOVED_HEAD
      throw original
    }
    await expect(
      disarmReviewedBeforePush('/tmp/wt', 7, {
        gh,
        push: kind === 'sync' ? fail : async () => fail(),
      }),
    ).rejects.toBe(original)
    expect(pushes).toBe(1)
    expect([...fake.pr.labels]).toEqual(['size:F-lite'])
    expect(fake.pr.autoMerge).toBe(null)
  })

  it.each(['disable', 'remove', 'readback', 'merged'])(
    'never invokes push after a failed %s barrier',
    async (fault) => {
      const fake = gatePr({ comments: [green()], headRefOid: REVIEWED_HEAD, ...ARMED })
      let pushes = 0
      let gateReads = 0
      const gh = async (cwd, args) => {
        if (same(args, GATE_READ(7)) && ++gateReads > 1 && fault === 'readback') throw new Error('readback unavailable')
        if (fault === 'disable' && disablesAuto(args)) throw new Error('disable failed')
        if (fault === 'remove' && removesLabel(args)) throw new Error('remove failed')
        const answer = await fake.gh(cwd, args)
        if (fault === 'merged' && removesLabel(args)) fake.pr.state = 'MERGED'
        return answer
      }
      await expect(
        disarmReviewedBeforePush('/tmp/wt', 7, {
          gh,
          push: () => {
            pushes++
          },
        }),
      ).rejects.toThrow(
        fault === 'merged'
          ? /merged while being disarmed/
          : fault === 'readback'
            ? /could not be read back/
            : /stays armed/,
      )
      expect(pushes).toBe(0)
      expect(fake.pr.autoMerge !== null).toBe(fault === 'disable')
      expect(fake.pr.labels.has('reviewed')).toBe(fault === 'remove')
    },
  )

  it('does not need review identity or comments to protect a push', async () => {
    const fake = gatePr({ comments: [green()], headRefOid: REVIEWED_HEAD, ...ARMED })
    const gh = async (cwd, args) => {
      if (same(args, IDENTITY) || same(args, commentPageArgs(7))) throw new Error('review service unavailable')
      return fake.gh(cwd, args)
    }
    expect(await disarmReviewedBeforePush('/tmp/wt', 7, { gh })).toEqual({ disarmed: true })
    expect([...fake.pr.labels]).toEqual(['size:F-lite'])
    expect(fake.pr.autoMerge).toBe(null)
  })
})

describe('landPr — configuration failures after acquiring the gate', () => {
  it.each([false, true])('clears the known armed gate when configuration throws (head moved: %s)', async (moved) => {
    const fake = gatePr({ comments: [green()], headRefOid: REVIEWED_HEAD, ...ARMED })
    const original = new Error('landing configuration unavailable')
    const gh = async (cwd, args) => {
      const answer = await fake.gh(cwd, args)
      if (moved && same(args, ['pr', 'view', '7', '--json', 'baseRefName'])) {
        await Promise.resolve()
        fake.pr.headRefOid = MOVED_HEAD
      }
      return answer
    }
    const landing = {
      get mode() {
        throw original
      },
      required_checks: ['ci'],
    }
    await expect(landPr('/tmp/wt', 7, { gh, landing })).rejects.toBe(original)
    expect(fake.pr.headRefOid).toBe(moved ? MOVED_HEAD : REVIEWED_HEAD)
    expect([...fake.pr.labels]).toEqual(['size:F-lite'])
    expect(fake.pr.autoMerge).toBe(null)
  })
})

describe('landPr — an approval arms only the commit it reviewed', () => {
  it('a push after an approving review is not-approved and writes nothing', async () => {
    const fake = gatePr({
      comments: [byMe(boundReview('Approve (clean)', REVIEWED_HEAD))],
      headRefOid: MOVED_HEAD,
    })
    const result = await landPr('/tmp/wt', 7, { gh: fake.gh, ...NATIVE })
    expect(result).toEqual({ status: 'not-approved', reviews: 0, reason: 'head-moved' })
    expect(noWrite(fake.calls)).toBe(false)
  })

  it('a head that moves after the approval check and before the write is not armed', async () => {
    const fake = gatePr({
      comments: [byMe(boundReview('Approve (clean)', REVIEWED_HEAD))],
      headRefOid: REVIEWED_HEAD,
    })
    const gh = async (cwd, args) => {
      const result = await fake.gh(cwd, args)
      if (args[1] === 'view' && args[4] === GATE_FIELDS) fake.pr.headRefOid = MOVED_HEAD
      return result
    }
    const result = await landPr('/tmp/wt', 7, { gh, ...NATIVE })
    expect(result).toEqual({ status: 'not-approved', reviews: 0, reason: 'head-moved' })
    expect(noWrite(fake.calls)).toBe(false)
  })

  it('an already-enabled auto-merge is re-pinned before the label', async () => {
    const fake = gatePr({
      comments: [byMe(boundReview('Approve (clean)', REVIEWED_HEAD))],
      headRefOid: REVIEWED_HEAD,
    })
    let enables = 0
    const gh = async (cwd, args) => {
      if (args[1] === 'merge' && args.includes('--auto')) {
        enables++
        if (enables === 1) throw new Error('GraphQL: Auto merge is already enabled')
      }
      return fake.gh(cwd, args)
    }
    const result = await landPr('/tmp/wt', 7, { gh, ...NATIVE })
    expect(result).toMatchObject({ status: 'watching', mode: 'native' })
    const pinAt = fake.calls.findIndex((args) => args.includes('--match-head-commit') && args.at(-1) === REVIEWED_HEAD)
    const labelAt = fake.calls.findIndex(armsLabel)
    expect(fake.calls.some((args) => args.includes('--disable-auto'))).toBe(true)
    expect(pinAt).toBeGreaterThanOrEqual(0)
    expect(labelAt).toBeGreaterThan(pinAt)
  })

  it('a failed re-pin of an already-enabled auto-merge adds no label', async () => {
    const fake = gatePr({
      comments: [byMe(boundReview('Approve (clean)', REVIEWED_HEAD))],
      headRefOid: REVIEWED_HEAD,
    })
    let enables = 0
    const gh = async (cwd, args) => {
      if (args[1] === 'merge' && args.includes('--auto')) {
        enables++
        if (enables === 1) throw new Error('already enabled')
        throw new Error('pin refused')
      }
      return fake.gh(cwd, args)
    }
    const result = await landPr('/tmp/wt', 7, { gh, ...NATIVE })
    expect(result).toEqual({ status: 'auto-merge-failed', armed: false })
    expect(fake.calls.some(armsLabel)).toBe(false)
  })

  it('an unreadable current head is head-moved, not an approval of nothing', async () => {
    const fake = gatePr({
      comments: [byMe(boundReview('Approve (clean)', REVIEWED_HEAD))],
      headRefOid: null,
    })
    const result = await landPr('/tmp/wt', 7, { gh: fake.gh, ...NATIVE })
    expect(result).toEqual({ status: 'not-approved', reviews: 0, reason: 'head-moved' })
    expect(noWrite(fake.calls)).toBe(false)
  })

  it('a non-JSON head view throws and writes nothing', async () => {
    const fake = gatePr({
      comments: [byMe(boundReview('Approve (clean)', REVIEWED_HEAD))],
      headRefOid: REVIEWED_HEAD,
    })
    const gh = async (cwd, args) => {
      if (args[1] === 'view' && args[4] === 'headRefOid') return 'not json'
      return fake.gh(cwd, args)
    }
    await expect(landPr('/tmp/wt', 7, { gh, ...NATIVE })).rejects.toThrow(/no JSON/)
    expect(noWrite(fake.calls)).toBe(false)
  })

  it('a review record with no head line does not arm', async () => {
    const fake = gatePr({ comments: [byMe(GREEN)], headRefOid: REVIEWED_HEAD })
    const result = await landPr('/tmp/wt', 7, { gh: fake.gh, ...NATIVE })
    expect(result).toEqual({ status: 'not-approved', reviews: 0, reason: 'no-review-head' })
    expect(noWrite(fake.calls)).toBe(false)
  })

  it('a missing head oid beside a record with no head line does not arm', async () => {
    const fake = gatePr({ comments: [byMe(GREEN)], headRefOid: null })
    const result = await landPr('/tmp/wt', 7, { gh: fake.gh, ...NATIVE })
    expect(result).toEqual({ status: 'not-approved', reviews: 0, reason: 'no-review-head' })
    expect(noWrite(fake.calls)).toBe(false)
  })

  it('a head marker quoted in the findings, with line 2 absent, does not arm', async () => {
    const quoted = `<!-- omp-build:code-review -->\n## Code Review\n\n${headLine(REVIEWED_HEAD)}\n\n**Verdict: Approve (clean)** — summary`
    const fake = gatePr({ comments: [byMe(quoted)], headRefOid: REVIEWED_HEAD })
    const result = await landPr('/tmp/wt', 7, { gh: fake.gh, ...NATIVE })
    expect(result).toEqual({ status: 'not-approved', reviews: 0, reason: 'no-review-head' })
    expect(noWrite(fake.calls)).toBe(false)
  })

  it.each([
    ['a 39-hex sha inside the marker', headLine(REVIEWED_HEAD.slice(0, 39))],
    ['a 41-hex sha inside the marker', headLine(`${REVIEWED_HEAD}a`)],
    ['an uppercase sha inside the marker', headLine(REVIEWED_HEAD.toUpperCase())],
    ['a line 2 with a prefix', `note ${headLine(REVIEWED_HEAD)}`],
    ['a line 2 with trailing text', `${headLine(REVIEWED_HEAD)} extra`],
  ])('%s does not arm, even when the embedded sha is the current head', async (_label, line2) => {
    const body = `<!-- omp-build:code-review -->\n${line2}\n## Code Review\n\n**Verdict: Approve (clean)** — summary`
    const fake = gatePr({ comments: [byMe(body)], headRefOid: REVIEWED_HEAD })
    const result = await landPr('/tmp/wt', 7, { gh: fake.gh, ...NATIVE })
    expect(result).toEqual({ status: 'not-approved', reviews: 0, reason: 'no-review-head' })
    expect(noWrite(fake.calls)).toBe(false)
  })

  it('an approving review of the current head arms, and native auto-merge is pinned to that commit', async () => {
    const fake = gatePr({
      comments: [byMe(boundReview('Approve (clean)', REVIEWED_HEAD))],
      headRefOid: REVIEWED_HEAD,
    })
    const result = await landPr('/tmp/wt', 7, { gh: fake.gh, ...NATIVE })
    expect(result).toMatchObject({ status: 'watching', mode: 'native' })
    expect(fake.calls).toContainEqual(['pr', 'merge', '7', '--auto', '--merge', '--match-head-commit', REVIEWED_HEAD])
    expect(fake.pr.labels.has('reviewed')).toBe(true)
  })

  it('the latest record names the commit that counts, not an earlier one', async () => {
    const stale = gatePr({ comments: [green(REVIEWED_HEAD), green(MOVED_HEAD)], headRefOid: REVIEWED_HEAD })
    const staleResult = await landPr('/tmp/wt', 7, { gh: stale.gh, ...NATIVE })
    expect(staleResult).toEqual({ status: 'not-approved', reviews: 0, reason: 'head-moved' })
    expect(noWrite(stale.calls)).toBe(false)
    const fresh = gatePr({ comments: [green(MOVED_HEAD), green(REVIEWED_HEAD)], headRefOid: REVIEWED_HEAD })
    const freshResult = await landPr('/tmp/wt', 7, { gh: fresh.gh, ...NATIVE })
    expect(freshResult).toMatchObject({ status: 'watching', mode: 'native' })
  })
  /**
   * @param {{ pr: { headRefOid: string | null }, calls: string[][] }} fake
   * @param {{ moveAt: number, firstMerge?: 'already-enabled', disableThrows?: boolean }} spec
   */
  function movingHead(fake, { moveAt, firstMerge, disableThrows = false }) {
    let reads = 0
    let merges = 0
    return async (cwd, args) => {
      if (args[1] === 'view' && args[4] === 'headRefOid') {
        reads += 1
        if (reads >= moveAt) fake.pr.headRefOid = MOVED_HEAD
      }
      if (disableThrows && args.includes('--disable-auto')) throw new Error('disable failed')
      if (firstMerge === 'already-enabled' && args[1] === 'merge' && args.includes('--auto')) {
        merges += 1
        if (merges === 1) throw new Error('already enabled')
      }
      return fake.gh(cwd, args)
    }
  }

  const approvedGate = () =>
    gatePr({
      comments: [byMe(boundReview('Approve (clean)', REVIEWED_HEAD))],
      headRefOid: REVIEWED_HEAD,
    })

  it('a head that moves after the pin is not-approved, auto-merge disabled, and unlabeled', async () => {
    const fake = approvedGate()
    const result = await landPr('/tmp/wt', 7, { gh: movingHead(fake, { moveAt: 2 }), ...NATIVE })
    expect(result).toEqual({ status: 'not-approved', reviews: 0, reason: 'head-moved', disarmed: true })
    expect(fake.pr.autoMerge).toBe(null)
    expect(fake.calls.some(armsLabel)).toBe(false)
    expect(fake.pr.labels.has('reviewed')).toBe(false)
  })

  it('a head that moves between disable and the second enable is not labeled', async () => {
    const fake = approvedGate()
    const result = await landPr('/tmp/wt', 7, {
      gh: movingHead(fake, { moveAt: 2, firstMerge: 'already-enabled' }),
      ...NATIVE,
    })
    expect(result).toEqual({ status: 'not-approved', reviews: 0, reason: 'head-moved' })
    expect(fake.calls.filter((args) => args[1] === 'merge' && args.includes('--auto'))).toHaveLength(0)
    expect(fake.calls.some(disablesAuto)).toBe(true)
    expect(fake.calls.some(armsLabel)).toBe(false)
  })

  it('disable-auto throwing after the pin moves returns auto-merge-failed, armed, and no label', async () => {
    const fake = approvedGate()
    const result = await landPr('/tmp/wt', 7, {
      gh: movingHead(fake, { moveAt: 2, disableThrows: true }),
      ...NATIVE,
    })
    expect(result).toEqual({
      status: 'auto-merge-failed',
      armed: true,
      error: expect.stringContaining('stays armed — auto-merge'),
    })
    expect(fake.calls.some(armsLabel)).toBe(false)
    expect(fake.pr.labels.has('reviewed')).toBe(false)
  })
})

describe('landPr — a native refusal for want of required checks disarms an armed gate', () => {
  /** An approved, armed PR whose protection read fails and whose rules are empty; the head can move at the repo read. */
  function armedForLookup({ headMovesAt } = {}) {
    const fake = gatePr({
      comments: [byMe(boundReview('Approve (clean)', REVIEWED_HEAD))],
      headRefOid: REVIEWED_HEAD,
      ...ARMED,
    })
    const gh = async (cwd, args) => {
      if (args[0] === 'repo' && headMovesAt === 'repo') fake.pr.headRefOid = MOVED_HEAD
      if (same(args, ['pr', 'view', '7', '--json', 'baseRefName'])) return JSON.stringify({ baseRefName: 'main' })
      if (args[0] === 'api' && String(args[1]).includes('/protection/')) throw new Error('HTTP 403')
      if (args[0] === 'api' && String(args[1]).includes('/rules/')) return '[]'
      return fake.gh(cwd, args)
    }
    return { fake, gh }
  }

  it.each([
    [
      'explicitly empty contexts',
      { landing: { mode: 'native', required_checks: [] }, requiredContexts: [] },
      undefined,
    ],
    [
      'discovered-empty contexts (protection unreadable, no rules)',
      { landing: { mode: 'native', required_checks: [] } },
      undefined,
    ],
    [
      'discovered-empty contexts, the head moving during the lookups',
      { landing: { mode: 'native', required_checks: [] } },
      'repo',
    ],
  ])(
    '%s: the approved, armed PR ends unarmed, and the result says it was disarmed',
    async (_label, options, headMovesAt) => {
      const { fake, gh } = armedForLookup({ headMovesAt })
      const result = await landPr('/tmp/wt', 7, { gh, ...options })
      expect(result).toEqual({ status: 'no-required-checks', disarmed: true })
      expect([...fake.pr.labels]).toEqual(['size:F-lite'])
      expect(fake.pr.autoMerge).toBe(null)
    },
  )

  it('an unarmed PR is left alone and no disarm is claimed', async () => {
    const fake = gatePr({
      comments: [byMe(boundReview('Approve (clean)', REVIEWED_HEAD))],
      headRefOid: REVIEWED_HEAD,
      labels: ['size:F-lite'],
    })
    const result = await landPr('/tmp/wt', 7, {
      gh: fake.gh,
      landing: { mode: 'native', required_checks: [] },
      requiredContexts: [],
    })
    expect(result).toEqual({ status: 'no-required-checks' })
    expect([...fake.pr.labels]).toEqual(['size:F-lite'])
    expect(fake.pr.autoMerge).toBe(null)
  })
})

describe('watch — native and merge-on-green share the same gate policy', () => {
  it.each([
    ['native', true],
    ['native', false],
    ['merge-on-green', true],
    ['merge-on-green', false],
  ])('%s observer keeps arms only for an approved current head (approved: %s)', async (mode, approved) => {
    const fake = gatePr({ comments: approved ? [green()] : [red()], headRefOid: REVIEWED_HEAD, ...ARMED })
    expect(await applyCiWatchExit('/tmp/wt', 7, 6, { mode, gh: fake.gh })).toEqual({
      status: 'evaluate-only',
      ...(!approved && { disarmed: true }),
    })
    expect(fake.pr.labels.has('reviewed')).toBe(approved)
    expect(fake.pr.autoMerge !== null).toBe(approved)
  })

  it.each(['native', 'merge-on-green'])('%s force-stop clears even a native auto-merge request', async (mode) => {
    const fake = gatePr({ comments: [green()], headRefOid: REVIEWED_HEAD, ...ARMED })
    expect(await applyCiWatchExit('/tmp/wt', 7, 1, { mode, gh: fake.gh })).toEqual({
      status: 'ci-failed',
      disarmed: true,
    })
    expect([...fake.pr.labels]).toEqual(['size:F-lite'])
    expect(fake.pr.autoMerge).toBeNull()
  })
})

describe('push — inactive gate receipts', () => {
  it.each(['CLOSED', 'MERGED'])(
    '%s at acquisition invokes the callback once without claiming disarm',
    async (state) => {
      const fake = gatePr({ comments: [green()], headRefOid: REVIEWED_HEAD, state, ...ARMED })
      let pushes = 0
      expect(
        await disarmReviewedBeforePush('/tmp/wt', 7, {
          gh: fake.gh,
          push: () => {
            pushes++
          },
        }),
      ).toEqual({})
      expect(pushes).toBe(1)
      expect([...fake.pr.labels]).toEqual(ARMED.labels)
      expect(fake.pr.autoMerge).toEqual(ARMED.autoMerge)
    },
  )
})

describe('push — terminal receipt reuse', () => {
  it.each(['sync', 'async'])(
    'returns the successful barrier receipt after a %s callback moves the head',
    async (kind) => {
      const fake = gatePr({ comments: [green()], headRefOid: REVIEWED_HEAD, ...ARMED })
      let callbackEntered = false
      let pushes = 0
      const gh = async (cwd, args) => {
        if (callbackEntered) throw new Error('GitHub unavailable after push')
        return fake.gh(cwd, args)
      }
      const push = () => {
        callbackEntered = true
        pushes++
        fake.pr.headRefOid = MOVED_HEAD
      }
      expect(
        await disarmReviewedBeforePush('/tmp/wt', 7, {
          gh,
          push: kind === 'sync' ? push : async () => push(),
        }),
      ).toEqual({ disarmed: true })
      expect(pushes).toBe(1)
      expect(fake.pr.headRefOid).toBe(MOVED_HEAD)
      expect([...fake.pr.labels]).toEqual(['size:F-lite'])
      expect(fake.pr.autoMerge).toBeNull()
    },
  )
})
