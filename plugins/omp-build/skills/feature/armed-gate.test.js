import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { commentPageArgs, landPr, nextReviewStep } from './workflow.js'

/**
 * The armed-gate invariant (#713). An OPEN PR is armed (`reviewed` label or
 * auto-merge) only when the latest review record approves the current head,
 * the review bound is not spent, and no review of that head is running.
 *
 * One stateful fake PR, shared by `landPr` and `nextReviewStep`. Every exit of
 * both after the gate read is a row of the table below; the sweep at the end
 * makes each gh call of a scripted run fail once, and move the head after it,
 * so a missed exit shows up as a violation of the oracle. The oracle is written
 * here from the fake's final state, not from `workflow.js`.
 */

const PR = 7
const ME = 'omp-bot'
const HEAD = '0123456789abcdef0123456789abcdef01234567'
const OLD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const MOVED = 'fedcba9876543210fedcba9876543210fedcba98'
const EVENT_AT = '2026-09-29T10:00:05Z'
const IDENTITY = ['api', 'user', '--jq', '.login']
const GATE_FIELDS = 'headRefOid,state,labels,autoMergeRequest'
const OTHER_LABEL = 'size:F-lite'

/** @param {unknown[]} args @param {unknown[]} expected */
const same = (args, expected) => args.length === expected.length && expected.every((arg, i) => args[i] === arg)

// --- review records, as structured data; rendered into comments by the fake ---
const approve = (head = HEAD) => ({ verdict: 'Approve (clean)', head })
const red = (head = HEAD) => ({ verdict: 'Request changes', head })
/** Conflicting verdict declarations: a record whose verdict is unknown. */
const undecided = (head = HEAD) => ({ verdict: null, head })
/** A record with no head line. @param {string} verdict */
const noHead = (verdict) => ({ verdict, head: null })

/** @param {{ verdict: string | null, head: string | null }} record */
function render(record) {
  const head = record.head ? `<!-- omp-build:review-head sha=${record.head} -->\n` : ''
  const verdict =
    record.verdict === null
      ? '**Verdict: Approve** — one\n**Verdict: Request changes** — two'
      : `**Verdict: ${record.verdict}** — summary`
  return `<!-- omp-build:code-review -->\n${head}## Code Review\n\n${verdict}`
}

// --- the stateful fake ------------------------------------------------------

/** @param {string[]} args */
function kindOf(args) {
  if (same(args, IDENTITY)) return 'identity'
  if (same(args, commentPageArgs(PR))) return 'comments'
  if (args[0] === 'pr' && args[1] === 'view' && args.length === 5) {
    return { [GATE_FIELDS]: 'gate', headRefOid: 'head', labels: 'labels' }[args[4]] ?? 'unexpected'
  }
  if (same(args, ['pr', 'merge', String(PR), '--disable-auto'])) return 'disable'
  if (same(args, ['pr', 'edit', String(PR), '--remove-label', 'reviewed'])) return 'remove'
  if (same(args, ['pr', 'edit', String(PR), '--add-label', 'reviewed'])) return 'add'
  if (args[0] === 'pr' && args[1] === 'merge' && args[3] === '--auto' && args[5] === '--match-head-commit') return 'pin'
  if (same(args, ['repo', 'view', '--json', 'nameWithOwner'])) return 'repo'
  if (args[0] === 'api' && String(args[1]).endsWith('/events')) return 'events'
  return 'unexpected'
}
const WRITES = new Set(['disable', 'remove', 'add', 'pin'])

const ARMED = {
  both: { labels: ['reviewed'], auto: true },
  label: { labels: ['reviewed'], auto: false },
  auto: { labels: [], auto: true },
  none: { labels: [], auto: false },
}

/**
 * @typedef {{ on: string, nth?: number, times?: number, error?: string, answer?: string, applies?: boolean }} Fail
 *   Make the nth call of a kind throw `error` (default 'injected'), or answer `answer`. `applies`: the write
 *   lands, then the call still throws.
 * @typedef {{ when: 'before' | 'after', on: string, nth?: number, head?: string, state?: string }} Move
 *   Move the head (or change the state) around the nth call of a kind.
 * @typedef {{ fail?: Fail[], moves?: Move[], failAt?: number, moveAfterCall?: number, events?: 'normal' | 'none' }} Script
 */

/**
 * @param {{ records?: ReturnType<typeof approve>[], start?: keyof typeof ARMED, state?: string, head?: string, script?: Script }} spec
 */
function armedPr({ records = [], start = 'both', state = 'OPEN', head = HEAD, script = {} } = {}) {
  const armed = ARMED[start]
  const pr = {
    labels: new Set([...armed.labels, OTHER_LABEL]),
    autoMerge: armed.auto ? { mergeMethod: 'MERGE' } : null,
    state,
    head,
    labeledAt: /** @type {string[]} */ ([]),
  }
  /** @type {{ kind: string, args: string[] }[]} */
  const log = []
  /** @type {Record<string, number>} */
  const seen = {}
  const matches = (rule, kind) =>
    rule.on === kind && seen[kind] >= (rule.nth ?? 1) && seen[kind] < (rule.nth ?? 1) + (rule.times ?? 1)
  const applyMoves = (when, kind) => {
    for (const move of script.moves ?? []) {
      if (move.when !== when || move.on !== kind || seen[kind] !== (move.nth ?? 1)) continue
      if (move.head) pr.head = move.head
      if (move.state) pr.state = move.state
    }
  }
  const perform = (kind, args) => {
    switch (kind) {
      case 'identity':
        return `${ME}\n`
      case 'comments':
        return JSON.stringify([
          records.map((record, index) => ({
            user: { login: ME },
            body: render(record),
            created_at: `2026-01-01T00:00:${String(index).padStart(2, '0')}Z`,
          })),
        ])
      case 'gate':
        return JSON.stringify({
          headRefOid: pr.head,
          state: pr.state,
          labels: [...pr.labels].map((name) => ({ name })),
          autoMergeRequest: pr.autoMerge,
        })
      case 'head':
        return JSON.stringify({ headRefOid: pr.head })
      case 'labels':
        return JSON.stringify({ labels: [...pr.labels].map((name) => ({ name })) })
      case 'disable':
        pr.autoMerge = null
        return ''
      case 'remove':
        pr.labels.delete('reviewed')
        return ''
      case 'add':
        pr.labels.add('reviewed')
        pr.labeledAt.push(EVENT_AT)
        return ''
      case 'pin':
        if (args.at(-1) !== pr.head) throw new Error(`match-head-commit ${args.at(-1)} does not match head ${pr.head}`)
        if (pr.autoMerge) throw new Error('GraphQL: Auto merge is already enabled')
        pr.autoMerge = { mergeMethod: 'MERGE' }
        return ''
      case 'repo':
        return JSON.stringify({ nameWithOwner: 'acme/app' })
      case 'events':
        return script.events === 'none' ? '' : pr.labeledAt.join('\n')
      default:
        throw new Error(`unexpected gh call: ${args.join(' ')}`)
    }
  }
  const gh = async (_cwd, args) => {
    const kind = kindOf(args)
    const index = log.length
    log.push({ kind, args })
    seen[kind] = (seen[kind] ?? 0) + 1
    applyMoves('before', kind)
    if (script.failAt === index) throw new Error('injected')
    const rule = (script.fail ?? []).find((candidate) => matches(candidate, kind))
    if (rule) {
      if (rule.answer !== undefined) return rule.answer
      if (rule.applies) perform(kind, args)
      throw new Error(rule.error ?? 'injected')
    }
    const out = perform(kind, args)
    applyMoves('after', kind)
    if (script.moveAfterCall === index) pr.head = MOVED
    return out
  }
  return { gh, pr, log, records }
}

const writesOf = (fake) => fake.log.filter((entry) => WRITES.has(entry.kind)).map((entry) => entry.kind)

// --- the oracle: from the fake's final true state, independent of workflow.js ----

const approves = (verdict) => typeof verdict === 'string' && verdict.startsWith('Approve')

/** What the fake's PR has armed right now, worded as the disarm error words it. */
function armedNames(fake) {
  const names = []
  if (fake.pr.autoMerge !== null) names.push('auto-merge')
  if (fake.pr.labels.has('reviewed')) names.push('the reviewed label')
  return names
}

/** May the fake's PR be armed by the records, at its current head? */
function mayBeArmed(fake, reviewing) {
  const latest = fake.records.at(-1)
  // A record past the second that does not approve spends the bound for good.
  const spent = fake.records.some((record, index) => index >= 2 && !approves(record.verdict))
  return !reviewing && latest !== undefined && approves(latest.verdict) && !spent && latest.head === fake.pr.head
}

/**
 * The invariant at exit: unarmed, or allowed by the records at the fake's current head, or
 * the call said exactly what stays armed. `exempt`: a read that failed before any gate was
 * read — the issue's explicit exception.
 */
function holds(fake, outcome, { reviewing = false, exempt = false } = {}) {
  if (fake.pr.state !== 'OPEN') return true
  const names = armedNames(fake)
  if (names.length === 0 || mayBeArmed(fake, reviewing) || exempt) return true
  const message = outcome.error?.message ?? outcome.result?.error ?? ''
  if (/could not be read back; auto-merge and reviewed may stay armed/.test(message)) return true
  const said = message.match(/stays armed — (auto-merge and the reviewed label|auto-merge|the reviewed label)/)
  return said !== null && said[1] === names.join(' and ')
}

// --- running one exit ---------------------------------------------------------

const NATIVE = { landing: { mode: 'native', required_checks: ['ci'] } }
const MOG = { landing: { mode: 'merge-on-green', required_checks: [] } }

/** A checkout whose `.dev/stack.yml` is not a valid landing. */
function badLandingCheckout() {
  const dir = mkdtempSync(join(tmpdir(), 'armed-gate-'))
  mkdirSync(join(dir, '.dev'))
  writeFileSync(join(dir, '.dev', 'stack.yml'), 'landing: nope\n')
  return dir
}

/**
 * @param {{ fn: 'land' | 'step', opts?: object, cwd?: string }} what
 * @param {ReturnType<typeof armedPr>} fake
 */
async function exec(what, fake) {
  try {
    const result =
      what.fn === 'land'
        ? await landPr(what.cwd ?? '/tmp/wt', PR, { gh: fake.gh, sleep: async () => {}, ...what.opts })
        : await nextReviewStep(what.cwd ?? '/tmp/wt', PR, { gh: fake.gh, ...what.opts })
    return { result, error: undefined }
  } catch (error) {
    return { result: undefined, error }
  }
}

// --- the exit table -----------------------------------------------------------

const REVIEWED = ['reviewed', OTHER_LABEL]
const CLEAN = [OTHER_LABEL]
const stays = (what) => new RegExp(`stays armed — ${what}${what === 'auto-merge' ? '(?! and)' : ''}`)

/** The three ways a second gate read can fail: refuse then falls back to what it knew. */
const GATE_READ_FAILURES = [
  ['throws', { error: 'gh: HTTP 502' }],
  ['is not JSON', { answer: 'not json' }],
  ['carries no labels', { answer: JSON.stringify({ headRefOid: HEAD, state: 'OPEN' }) }],
]

/**
 * Row fields: `fn`, `opts`, `records`, `start`, `state`, `head`, `script`, and what must hold at exit —
 * `result` (exact) or `rejects` (message), `labels` (what is left), `auto` (auto-merge still on),
 * `none` (no write at all). `reviewing` is read by the oracle.
 */
const LAND_REFUSALS = [
  [
    'L1 review-bound',
    { records: [red(), red(), red(), approve()] },
    { status: 'not-approved', reviews: 4, reason: 'review-bound', disarmed: true },
  ],
  [
    'L2 latest record does not approve',
    { records: [approve(), red()] },
    { status: 'not-approved', reviews: 2, disarmed: true },
  ],
  [
    'L3 no review head',
    { records: [noHead('Approve (clean)')] },
    { status: 'not-approved', reviews: 1, reason: 'no-review-head', disarmed: true },
  ],
  [
    'L4 head moved before the call',
    { records: [approve()], head: MOVED },
    { status: 'not-approved', reviews: 1, reason: 'head-moved', disarmed: true },
  ],
  [
    'L4 the record names an older head',
    { records: [approve(OLD)] },
    { status: 'not-approved', reviews: 1, reason: 'head-moved', disarmed: true },
  ],
]

/** @type {[string, object][]} */
const ROWS = [
  // ---- landPr: refusals ------------------------------------------------------
  ...LAND_REFUSALS.flatMap(([name, spec, result]) =>
    ['native', 'merge-on-green'].map((mode) => [
      `${name}, ${mode}: disarmed, nothing else written`,
      {
        fn: 'land',
        opts: mode === 'native' ? NATIVE : MOG,
        ...spec,
        result,
        labels: CLEAN,
        auto: false,
        writesOnly: ['disable', 'remove'],
      },
    ]),
  ),
  [
    'L1-L4 over an unarmed PR: not-approved, no disarmed claim, nothing written',
    {
      fn: 'land',
      opts: NATIVE,
      records: [red()],
      start: 'none',
      result: { status: 'not-approved', reviews: 1 },
      labels: CLEAN,
      auto: false,
      none: true,
    },
  ],
  [
    'L1-L4 on a CLOSED PR: left alone',
    {
      fn: 'land',
      opts: NATIVE,
      records: [red()],
      state: 'CLOSED',
      result: { status: 'not-approved', reviews: 1 },
      labels: REVIEWED,
      auto: true,
      none: true,
    },
  ],
  [
    'L4 refused while the disarm cannot disable auto-merge: throws naming auto-merge, the label is still removed',
    {
      fn: 'land',
      opts: NATIVE,
      records: [approve(OLD)],
      script: { fail: [{ on: 'disable' }] },
      rejects: stays('auto-merge'),
      labels: CLEAN,
      auto: true,
    },
  ],
  [
    'L5 bad-landing: the gate is left as it was (it was allowed)',
    {
      fn: 'land',
      opts: {},
      cwd: 'BAD_LANDING',
      records: [approve()],
      result: { status: 'bad-landing', error: expect.any(String) },
      labels: REVIEWED,
      auto: true,
      none: true,
    },
  ],
  [
    'L6 no-required-checks: the gate is left as it was',
    {
      fn: 'land',
      opts: { landing: NATIVE.landing, requiredContexts: [] },
      records: [approve()],
      result: { status: 'no-required-checks' },
      labels: REVIEWED,
      auto: true,
      none: true,
    },
  ],

  // ---- landPr: gate and history reads fail on a red armed PR ------------------
  ...[
    ['the gate read throws', { on: 'gate', error: 'gh: HTTP 502' }],
    ['the gate read is not JSON', { on: 'gate', answer: 'not json' }],
    ['the gate read carries no labels', { on: 'gate', answer: JSON.stringify({ headRefOid: HEAD, state: 'OPEN' }) }],
    ['the identity read throws', { on: 'identity', error: 'gh: not logged in' }],
    ['the comment read throws', { on: 'comments', error: 'gh: HTTP 502' }],
  ].flatMap(([name, fail]) =>
    ['native', 'merge-on-green'].map((mode) => [
      `RC-3 landPr, ${mode}: ${name} on an armed red PR → rejects and writes nothing`,
      {
        fn: 'land',
        opts: mode === 'native' ? NATIVE : MOG,
        records: [red()],
        script: { fail: [fail] },
        rejects: /./,
        labels: REVIEWED,
        auto: true,
        none: true,
        exempt: true,
      },
    ]),
  ),

  // ---- landPr: merge-on-green ------------------------------------------------
  [
    'M1 merge-on-green: the labels view is not JSON → rejects, nothing written',
    {
      fn: 'land',
      opts: MOG,
      records: [approve()],
      script: { fail: [{ on: 'labels', answer: 'not json' }] },
      rejects: /./,
      labels: REVIEWED,
      auto: true,
      none: true,
    },
  ],
  [
    'M2 merge-on-green: the head re-read throws before any write → rejects, nothing written',
    {
      fn: 'land',
      opts: MOG,
      records: [approve()],
      script: { fail: [{ on: 'head' }] },
      rejects: /injected/,
      labels: REVIEWED,
      auto: true,
      none: true,
    },
  ],
  [
    'M3 merge-on-green: the head moved before the write → refused and disarmed',
    {
      fn: 'land',
      opts: MOG,
      records: [approve()],
      script: { moves: [{ when: 'before', on: 'head', nth: 1, head: MOVED }] },
      result: { status: 'not-approved', reviews: 1, reason: 'head-moved', disarmed: true },
      labels: CLEAN,
      auto: false,
      writesOnly: ['disable', 'remove'],
    },
  ],
  ...GATE_READ_FAILURES.map(([how, fail]) => [
    `B1 M3 merge-on-green: head moved, and the second gate read ${how} → still disarmed from the first read`,
    {
      fn: 'land',
      opts: MOG,
      records: [approve()],
      script: { moves: [{ when: 'before', on: 'head', nth: 1, head: MOVED }], fail: [{ on: 'gate', nth: 2, ...fail }] },
      result: { status: 'not-approved', reviews: 1, reason: 'head-moved', disarmed: true },
      labels: CLEAN,
      auto: false,
    },
  ]),
  [
    'M4 merge-on-green: removing the old label throws → rejects, head was verified, label stays',
    {
      fn: 'land',
      opts: MOG,
      records: [approve()],
      script: { fail: [{ on: 'remove' }] },
      rejects: /injected/,
      labels: REVIEWED,
      auto: true,
    },
  ],
  [
    'M4 merge-on-green: adding the label throws after the old one was removed → rejects, unlabelled',
    {
      fn: 'land',
      opts: MOG,
      records: [approve()],
      script: { fail: [{ on: 'add' }] },
      rejects: /injected/,
      labels: CLEAN,
      auto: true,
    },
  ],
  [
    'M5 merge-on-green: no labeled event → watch-failed, labelled at a verified head',
    {
      fn: 'land',
      opts: MOG,
      records: [approve()],
      script: { events: 'none' },
      result: { status: 'watch-failed', error: expect.any(String) },
      labels: REVIEWED,
      auto: true,
    },
  ],
  [
    'M5 merge-on-green: watching, labelled at a verified head',
    {
      fn: 'land',
      opts: MOG,
      records: [approve()],
      start: 'none',
      result: { status: 'watching', mode: 'merge-on-green', watch: expect.stringContaining('--since') },
      labels: REVIEWED,
      auto: false,
    },
  ],
  [
    'M5 merge-on-green: the head moves during the labeled-event poll → refused and disarmed',
    {
      fn: 'land',
      opts: MOG,
      records: [approve()],
      start: 'none',
      script: { moves: [{ when: 'after', on: 'events', nth: 2, head: MOVED }] },
      result: { status: 'not-approved', reviews: 1, reason: 'head-moved', disarmed: true },
      labels: CLEAN,
      auto: false,
    },
  ],
  [
    'M5 merge-on-green: the head moves during a failed labeled-event poll → refused and disarmed, not watch-failed',
    {
      fn: 'land',
      opts: MOG,
      records: [approve()],
      start: 'none',
      script: { events: 'none', moves: [{ when: 'after', on: 'events', nth: 2, head: MOVED }] },
      result: { status: 'not-approved', reviews: 1, reason: 'head-moved', disarmed: true },
      labels: CLEAN,
      auto: false,
    },
  ],
  [
    'M5 merge-on-green: the head re-read after the poll throws → label removed, not-approved',
    {
      fn: 'land',
      opts: MOG,
      records: [approve()],
      start: 'none',
      script: { fail: [{ on: 'head', nth: 3 }] },
      result: { status: 'not-approved', reviews: 1, reason: 'head-moved', disarmed: true },
      labels: CLEAN,
      auto: false,
    },
  ],
  [
    'M5 merge-on-green: that re-read throws and the label cannot be removed → names the label',
    {
      fn: 'land',
      opts: MOG,
      records: [approve()],
      start: 'none',
      script: { fail: [{ on: 'head', nth: 3 }, { on: 'remove' }] },
      rejects: stays('the reviewed label'),
      labels: REVIEWED,
      auto: false,
    },
  ],
  [
    'M6 merge-on-green: the head moves right after the label write → refused and disarmed',
    {
      fn: 'land',
      opts: MOG,
      records: [approve()],
      start: 'none',
      script: { moves: [{ when: 'after', on: 'add', head: MOVED }] },
      result: { status: 'not-approved', reviews: 1, reason: 'head-moved', disarmed: true },
      labels: CLEAN,
      auto: false,
    },
  ],
  ...GATE_READ_FAILURES.map(([how, fail]) => [
    `B1 M6 merge-on-green: label written, head moved, the second gate read ${how} → label removed from what the call wrote`,
    {
      fn: 'land',
      opts: MOG,
      records: [approve()],
      start: 'none',
      script: { moves: [{ when: 'after', on: 'add', head: MOVED }], fail: [{ on: 'gate', nth: 2, ...fail }] },
      result: { status: 'not-approved', reviews: 1, reason: 'head-moved', disarmed: true },
      labels: CLEAN,
      auto: false,
    },
  ]),
  [
    'M6 merge-on-green: the head re-read after the label write throws → label removed, error rethrown',
    {
      fn: 'land',
      opts: MOG,
      records: [approve()],
      start: 'none',
      script: { fail: [{ on: 'head', nth: 2 }] },
      rejects: /^injected$/,
      labels: CLEAN,
      auto: false,
    },
  ],
  [
    'M6 merge-on-green: that re-read throws and the label cannot be removed → names the label',
    {
      fn: 'land',
      opts: MOG,
      records: [approve()],
      start: 'none',
      script: { fail: [{ on: 'head', nth: 2 }, { on: 'remove' }] },
      rejects: stays('the reviewed label'),
      labels: REVIEWED,
      auto: false,
    },
  ],

  // ---- landPr: native --------------------------------------------------------
  [
    'N1 native: the head re-read before the pin throws → rejects, nothing written',
    {
      fn: 'land',
      opts: NATIVE,
      records: [approve()],
      start: 'label',
      script: { fail: [{ on: 'head' }] },
      rejects: /injected/,
      labels: REVIEWED,
      auto: false,
      none: true,
    },
  ],
  [
    'N2 native: the head moved before the pin → refused and disarmed',
    {
      fn: 'land',
      opts: NATIVE,
      records: [approve()],
      start: 'label',
      script: { moves: [{ when: 'before', on: 'head', nth: 1, head: MOVED }] },
      result: { status: 'not-approved', reviews: 1, reason: 'head-moved', disarmed: true },
      labels: CLEAN,
      auto: false,
      writesOnly: ['remove'],
    },
  ],
  ...GATE_READ_FAILURES.map(([how, fail]) => [
    `B1 N2 native: head moved before the pin, the second gate read ${how} → disarmed from the first read`,
    {
      fn: 'land',
      opts: NATIVE,
      records: [approve()],
      start: 'label',
      script: { moves: [{ when: 'before', on: 'head', nth: 1, head: MOVED }], fail: [{ on: 'gate', nth: 2, ...fail }] },
      result: { status: 'not-approved', reviews: 1, reason: 'head-moved', disarmed: true },
      labels: CLEAN,
      auto: false,
    },
  ]),
  [
    'N3 native: the pin fails → auto-merge-failed, not armed by this call; the gate was allowed',
    {
      fn: 'land',
      opts: NATIVE,
      records: [approve()],
      start: 'label',
      script: { fail: [{ on: 'pin', error: 'HTTP 502' }] },
      result: { status: 'auto-merge-failed', armed: false },
      labels: REVIEWED,
      auto: false,
    },
  ],
  [
    'N3 native: the pin is refused because the head moved since the pre-pin read → refused and disarmed',
    {
      fn: 'land',
      opts: NATIVE,
      records: [approve()],
      start: 'label',
      script: { moves: [{ when: 'after', on: 'head', nth: 1, head: MOVED }] },
      result: { status: 'not-approved', reviews: 1, reason: 'head-moved', disarmed: true },
      labels: CLEAN,
      auto: false,
    },
  ],
  [
    'N3 native: the pin fails and the head cannot be read back → auto-merge-failed, the gate as it was',
    {
      fn: 'land',
      opts: NATIVE,
      records: [approve()],
      start: 'label',
      script: { fail: [{ on: 'pin' }, { on: 'head', nth: 2 }] },
      result: { status: 'auto-merge-failed', armed: false },
      labels: REVIEWED,
      auto: false,
    },
  ],
  [
    'N6 native: the second pin is refused because the head moved → refused and disarmed',
    {
      fn: 'land',
      opts: NATIVE,
      records: [approve()],
      start: 'both',
      script: { moves: [{ when: 'after', on: 'head', nth: 2, head: MOVED }] },
      result: { status: 'not-approved', reviews: 1, reason: 'head-moved', disarmed: true },
      labels: CLEAN,
      auto: false,
    },
  ],
  [
    'N4 native: auto-merge already on → disabled and pinned again at the verified head, then watching',
    {
      fn: 'land',
      opts: NATIVE,
      records: [approve()],
      start: 'both',
      result: { status: 'watching', mode: 'native', watch: expect.any(String) },
      labels: REVIEWED,
      auto: true,
    },
  ],
  [
    'N4 native: already enabled and the disable fails → auto-merge-failed armed, naming what stays, at a verified head',
    {
      fn: 'land',
      opts: NATIVE,
      records: [approve()],
      start: 'both',
      script: { fail: [{ on: 'disable' }] },
      result: {
        status: 'auto-merge-failed',
        armed: true,
        error: expect.stringMatching(/stays armed — auto-merge and the reviewed label/),
      },
      labels: REVIEWED,
      auto: true,
    },
  ],
  [
    'N4 native: already enabled, the disable fails, and the head moved → auto-merge-failed armed, naming what stays',
    {
      fn: 'land',
      opts: NATIVE,
      records: [approve()],
      start: 'both',
      script: {
        fail: [{ on: 'disable', times: 2 }, { on: 'remove' }],
        moves: [{ when: 'before', on: 'disable', head: MOVED }],
      },
      result: {
        status: 'auto-merge-failed',
        armed: true,
        error: expect.stringMatching(/stays armed — auto-merge and the reviewed label/),
      },
      labels: REVIEWED,
      auto: true,
    },
  ],
  [
    'N4 native: already enabled, the disable fails, and the head cannot be read → auto-merge-failed armed, naming what stays',
    {
      fn: 'land',
      opts: NATIVE,
      records: [approve()],
      start: 'both',
      script: { fail: [{ on: 'disable', times: 2 }, { on: 'head', nth: 2 }, { on: 'remove' }] },
      result: {
        status: 'auto-merge-failed',
        armed: true,
        error: expect.stringMatching(/stays armed — auto-merge and the reviewed label/),
      },
      labels: REVIEWED,
      auto: true,
    },
  ],
  [
    'N5 native: the head moved after the disable → refused and disarmed',
    {
      fn: 'land',
      opts: NATIVE,
      records: [approve()],
      start: 'both',
      script: { moves: [{ when: 'after', on: 'disable', head: MOVED }] },
      result: { status: 'not-approved', reviews: 1, reason: 'head-moved', disarmed: true },
      labels: CLEAN,
      auto: false,
    },
  ],
  ...GATE_READ_FAILURES.map(([how, fail]) => [
    `B1 N5 native: head moved after the disable, the second gate read ${how} → disarmed from the first read`,
    {
      fn: 'land',
      opts: NATIVE,
      records: [approve()],
      start: 'both',
      script: { moves: [{ when: 'after', on: 'disable', head: MOVED }], fail: [{ on: 'gate', nth: 2, ...fail }] },
      result: { status: 'not-approved', reviews: 1, reason: 'head-moved', disarmed: true },
      labels: CLEAN,
      auto: false,
    },
  ]),
  [
    'N5 native: the head re-read after the disable throws → rejects; auto-merge is off',
    {
      fn: 'land',
      opts: NATIVE,
      records: [approve()],
      start: 'both',
      script: { fail: [{ on: 'head', nth: 2 }] },
      rejects: /injected/,
      labels: REVIEWED,
      auto: false,
    },
  ],
  [
    'N6 native: the second pin fails → auto-merge-failed, auto-merge off',
    {
      fn: 'land',
      opts: NATIVE,
      records: [approve()],
      start: 'both',
      script: { fail: [{ on: 'pin', nth: 2 }] },
      result: { status: 'auto-merge-failed', armed: false },
      labels: REVIEWED,
      auto: false,
    },
  ],
  [
    'N7 native: the head re-read after the pin throws → disarmed, original error rethrown',
    {
      fn: 'land',
      opts: NATIVE,
      records: [approve()],
      start: 'label',
      script: { fail: [{ on: 'head', nth: 2 }] },
      rejects: /^injected$/,
      labels: CLEAN,
      auto: false,
    },
  ],
  [
    'N7 native: that re-read throws and the disable fails → auto-merge-failed armed, naming auto-merge and the read error',
    {
      fn: 'land',
      opts: NATIVE,
      records: [approve()],
      start: 'label',
      script: { fail: [{ on: 'head', nth: 2 }, { on: 'disable' }] },
      result: {
        status: 'auto-merge-failed',
        armed: true,
        error: expect.stringMatching(/stays armed — auto-merge.*after: injected/),
      },
      labels: CLEAN,
      auto: true,
    },
  ],
  [
    'N7 native: that re-read throws and the head moved with it → disarmed',
    {
      fn: 'land',
      opts: NATIVE,
      records: [approve()],
      start: 'none',
      script: { moves: [{ when: 'after', on: 'pin', head: MOVED }], fail: [{ on: 'head', nth: 2 }] },
      rejects: /^injected$/,
      labels: CLEAN,
      auto: false,
    },
  ],
  [
    'N8 native: the head moved after the pin → disarmed through the one disarm',
    {
      fn: 'land',
      opts: NATIVE,
      records: [approve()],
      start: 'label',
      script: { moves: [{ when: 'after', on: 'pin', head: MOVED }] },
      result: { status: 'not-approved', reviews: 1, reason: 'head-moved', disarmed: true },
      labels: CLEAN,
      auto: false,
      writesOnly: ['pin', 'disable', 'remove'],
    },
  ],
  [
    'N8 native: moved after the pin, the disable fails → auto-merge-failed armed naming auto-merge; the label is removed anyway',
    {
      fn: 'land',
      opts: NATIVE,
      records: [approve()],
      start: 'label',
      script: { moves: [{ when: 'after', on: 'pin', head: MOVED }], fail: [{ on: 'disable' }] },
      result: { status: 'auto-merge-failed', armed: true, error: expect.stringMatching(stays('auto-merge')) },
      labels: CLEAN,
      auto: true,
    },
  ],
  [
    'N8 native: moved after the pin, the label removal fails → auto-merge-failed armed naming the label; auto-merge is off',
    {
      fn: 'land',
      opts: NATIVE,
      records: [approve()],
      start: 'label',
      script: { moves: [{ when: 'after', on: 'pin', head: MOVED }], fail: [{ on: 'remove' }] },
      result: { status: 'auto-merge-failed', armed: true, error: expect.stringMatching(stays('the reviewed label')) },
      labels: REVIEWED,
      auto: false,
    },
  ],
  [
    'N8 native: moved after the pin, both writes fail → auto-merge-failed armed naming both',
    {
      fn: 'land',
      opts: NATIVE,
      records: [approve()],
      start: 'label',
      script: { moves: [{ when: 'after', on: 'pin', head: MOVED }], fail: [{ on: 'disable' }, { on: 'remove' }] },
      result: {
        status: 'auto-merge-failed',
        armed: true,
        error: expect.stringMatching(stays('auto-merge and the reviewed label')),
      },
      labels: REVIEWED,
      auto: true,
    },
  ],
  ...GATE_READ_FAILURES.map(([how, fail]) => [
    `B1 N8 native: head moved after the pin, the second gate read ${how} → disarmed, auto-merge included`,
    {
      fn: 'land',
      opts: NATIVE,
      records: [approve()],
      start: 'label',
      script: { moves: [{ when: 'after', on: 'pin', head: MOVED }], fail: [{ on: 'gate', nth: 2, ...fail }] },
      result: { status: 'not-approved', reviews: 1, reason: 'head-moved', disarmed: true },
      labels: CLEAN,
      auto: false,
    },
  ]),
  [
    'N9 native: the label write throws after a verified pin → rejects; auto-merge is pinned to the verified head',
    {
      fn: 'land',
      opts: NATIVE,
      records: [approve()],
      start: 'none',
      script: { fail: [{ on: 'add' }] },
      rejects: /injected/,
      labels: CLEAN,
      auto: true,
    },
  ],
  [
    'N10 native: watching, armed at the verified head',
    {
      fn: 'land',
      opts: NATIVE,
      records: [approve()],
      start: 'none',
      result: { status: 'watching', mode: 'native', watch: expect.any(String) },
      labels: REVIEWED,
      auto: true,
    },
  ],
  [
    'N10 native: the head moves after the label write → refused and disarmed',
    {
      fn: 'land',
      opts: NATIVE,
      records: [approve()],
      start: 'none',
      script: { moves: [{ when: 'after', on: 'add', head: MOVED }] },
      result: { status: 'not-approved', reviews: 1, reason: 'head-moved', disarmed: true },
      labels: CLEAN,
      auto: false,
    },
  ],
  [
    'N10 native: the head re-read after the label write throws → the label this call added is removed',
    {
      fn: 'land',
      opts: NATIVE,
      records: [approve()],
      start: 'none',
      script: { fail: [{ on: 'head', nth: 3 }] },
      result: { status: 'not-approved', reviews: 1, reason: 'head-moved', disarmed: true },
      labels: CLEAN,
      auto: false,
    },
  ],
  [
    'N10 native: that re-read throws and the label cannot be removed → names the label',
    {
      fn: 'land',
      opts: NATIVE,
      records: [approve()],
      start: 'none',
      script: { fail: [{ on: 'head', nth: 3 }, { on: 'remove' }] },
      rejects: stays('the reviewed label'),
      labels: REVIEWED,
      auto: false,
    },
  ],

  // ---- nextReviewStep: reviewStep branches ---------------------------------
  [
    'S1 posted with a malformed shape → TypeError before any read',
    {
      fn: 'step',
      opts: { posted: { verdict: 'Maybe', head: HEAD } },
      records: [red()],
      rejects: /posted must be/,
      errorType: TypeError,
      labels: REVIEWED,
      auto: true,
      none: true,
      noCalls: true,
      exempt: true,
    },
  ],
  [
    'S1 posted that is not the latest record, over an approving current gate → throws, the gate stays armed',
    {
      fn: 'step',
      opts: { posted: { verdict: 'Request changes', head: HEAD } },
      records: [approve()],
      rejects: /not the one just posted/,
      labels: REVIEWED,
      auto: true,
      none: true,
    },
  ],
  [
    'S1 posted that is not the latest record, over a red gate → throws, the gate is disarmed first',
    {
      fn: 'step',
      opts: { posted: { verdict: 'Approve (clean)', head: HEAD } },
      records: [red()],
      rejects: /not the one just posted/,
      labels: CLEAN,
      auto: false,
    },
  ],
  [
    'S1 posted mismatch while reviewing, over an approving gate → throws, the gate is disarmed',
    {
      fn: 'step',
      opts: { posted: { verdict: 'Request changes', head: HEAD }, reviewing: true },
      reviewing: true,
      records: [approve()],
      rejects: /not the one just posted/,
      labels: CLEAN,
      auto: false,
    },
  ],
  [
    'S1 posted mismatch over a red gate, and the disable fails → the original error with the disarm failure appended',
    {
      fn: 'step',
      opts: { posted: { verdict: 'Approve (clean)', head: HEAD } },
      records: [red()],
      script: { fail: [{ on: 'disable' }] },
      rejects: /not the one just posted[\s\S]*disarm failed[\s\S]*stays armed — auto-merge/,
      causeMatches: /not the one just posted/,
      labels: CLEAN,
      auto: true,
    },
  ],
  [
    'S1 ci-failed over a red latest record → throws, the gate is disarmed first',
    {
      fn: 'step',
      opts: { ciFailed: true },
      records: [red()],
      rejects: /a ci-failed fix needs/,
      labels: CLEAN,
      auto: false,
    },
  ],
  [
    'S1 ci-failed over an approval of another head → throws, the gate is disarmed first',
    {
      fn: 'step',
      opts: { ciFailed: true },
      records: [approve(OLD)],
      rejects: /a ci-failed fix needs/,
      labels: CLEAN,
      auto: false,
    },
  ],
  [
    'S2 stop (spent bound) → disarmed',
    {
      fn: 'step',
      records: [red(), red(), red()],
      result: { action: 'stop', reason: 'review-bound', reviews: 3, message: expect.any(String), disarmed: true },
      labels: CLEAN,
      auto: false,
    },
  ],
  [
    'S2 ci-failed stop → disarmed',
    {
      fn: 'step',
      opts: { ciFailed: true },
      records: [red(), red(), approve()],
      result: { action: 'stop', reason: 'ci-failed', reviews: 3, message: expect.any(String), disarmed: true },
      labels: CLEAN,
      auto: false,
    },
  ],
  [
    'S2 ci-failed fix → disarmed',
    {
      fn: 'step',
      opts: { ciFailed: true },
      records: [approve()],
      result: { action: 'fix', reviews: 1, remaining: 1, reason: 'ci-failed', disarmed: true },
      labels: CLEAN,
      auto: false,
    },
  ],
  [
    'S2 fix on a request-changes record → disarmed',
    {
      fn: 'step',
      records: [red()],
      result: { action: 'fix', reviews: 1, remaining: 1, disarmed: true },
      labels: CLEAN,
      auto: false,
    },
  ],
  [
    'S2 review, no record yet → disarmed',
    {
      fn: 'step',
      records: [],
      result: { action: 'review', reason: 'no-review', reviews: 0, disarmed: true },
      labels: CLEAN,
      auto: false,
    },
  ],
  [
    'S2 review, the record names another head → disarmed',
    {
      fn: 'step',
      records: [approve(OLD)],
      result: { action: 'review', reason: 'head-moved', reviews: 1, disarmed: true },
      labels: CLEAN,
      auto: false,
    },
  ],
  [
    'S2 review, the record has no verdict → disarmed',
    {
      fn: 'step',
      records: [undecided()],
      result: { action: 'review', reason: 'no-verdict', reviews: 1, disarmed: true },
      labels: CLEAN,
      auto: false,
    },
  ],
  [
    'S3 land while a review starts → disarmed',
    {
      fn: 'step',
      opts: { reviewing: true },
      reviewing: true,
      records: [approve()],
      result: { action: 'land', reviews: 1, disarmed: true },
      labels: CLEAN,
      auto: false,
    },
  ],
  [
    'S4 land → the gate is kept (the record approves the current head)',
    {
      fn: 'step',
      records: [approve()],
      result: { action: 'land', reviews: 1 },
      labels: REVIEWED,
      auto: true,
      none: true,
    },
  ],
  [
    'S2 a fix over an unarmed PR → nothing written, no disarmed claim',
    {
      fn: 'step',
      records: [red()],
      start: 'none',
      result: { action: 'fix', reviews: 1, remaining: 1 },
      labels: CLEAN,
      auto: false,
      none: true,
    },
  ],
  ...['CLOSED', 'MERGED'].map((state) => [
    `S2 a fix over a ${state} PR → left alone`,
    {
      fn: 'step',
      records: [red()],
      state,
      result: { action: 'fix', reviews: 1, remaining: 1 },
      labels: REVIEWED,
      auto: true,
      none: true,
    },
  ]),
  [
    'S2 only the label is armed → one write, the label',
    {
      fn: 'step',
      records: [red()],
      start: 'label',
      result: { action: 'fix', reviews: 1, remaining: 1, disarmed: true },
      labels: CLEAN,
      auto: false,
      writesOnly: ['remove'],
    },
  ],
  [
    'S2 only auto-merge is armed → one write, the disable',
    {
      fn: 'step',
      records: [red()],
      start: 'auto',
      result: { action: 'fix', reviews: 1, remaining: 1, disarmed: true },
      labels: CLEAN,
      auto: false,
      writesOnly: ['disable'],
    },
  ],

  // ---- nextReviewStep: reads that fail ----------------------------------------
  ...[
    ['the gate read throws', { on: 'gate', error: 'gh: HTTP 502' }],
    ['the gate read is not JSON', { on: 'gate', answer: 'not json' }],
    ['the gate read carries no labels', { on: 'gate', answer: JSON.stringify({ headRefOid: HEAD, state: 'OPEN' }) }],
    ['the identity read throws', { on: 'identity', error: 'gh: not logged in' }],
    ['the comment read throws', { on: 'comments', error: 'gh: HTTP 502' }],
  ].map(([name, fail]) => [
    `RC-3 nextReviewStep: ${name} on an armed red PR → rejects and writes nothing`,
    {
      fn: 'step',
      records: [red()],
      script: { fail: [fail] },
      rejects: /./,
      labels: REVIEWED,
      auto: true,
      none: true,
      exempt: true,
    },
  ]),

  // ---- the disarm itself (S5, AC1) ------------------------------------------
  [
    'S5 disarm: the disable fails alone → throws naming auto-merge; the label is removed anyway',
    {
      fn: 'step',
      records: [red()],
      script: { fail: [{ on: 'disable' }] },
      rejects: stays('auto-merge'),
      labels: CLEAN,
      auto: true,
    },
  ],
  [
    'S5 disarm: the label removal fails alone → throws naming the label; auto-merge is off',
    {
      fn: 'step',
      records: [red()],
      script: { fail: [{ on: 'remove' }] },
      rejects: stays('the reviewed label'),
      labels: REVIEWED,
      auto: false,
    },
  ],
  [
    'S5 disarm: both writes fail → one error naming both, with both write errors',
    {
      fn: 'step',
      records: [red()],
      script: {
        fail: [
          { on: 'disable', error: 'no disable' },
          { on: 'remove', error: 'no remove' },
        ],
      },
      rejects: /stays armed — auto-merge and the reviewed label[\s\S]*no disable[\s\S]*no remove/,
      labels: REVIEWED,
      auto: true,
    },
  ],
  [
    'S5 disarm: the read-back cannot be read → throws that both may stay armed',
    {
      fn: 'step',
      records: [red()],
      script: { fail: [{ on: 'gate', nth: 2 }] },
      rejects: /could not be read back; auto-merge and reviewed may stay armed/,
      labels: CLEAN,
      auto: false,
    },
  ],
  [
    'S5 disarm: the read-back is not JSON → throws that both may stay armed',
    {
      fn: 'step',
      records: [red()],
      script: { fail: [{ on: 'gate', nth: 2, answer: 'not json' }] },
      rejects: /could not be read back/,
      labels: CLEAN,
      auto: false,
    },
  ],
  [
    'S5 disarm: the PR merged while being disarmed → throws',
    {
      fn: 'step',
      records: [red()],
      script: { moves: [{ when: 'after', on: 'remove', state: 'MERGED' }] },
      rejects: /merged while being disarmed/,
      labels: CLEAN,
      auto: false,
    },
  ],
  [
    'S5 disarm: the PR closed while being disarmed → no error',
    {
      fn: 'step',
      records: [red()],
      script: { moves: [{ when: 'after', on: 'remove', state: 'CLOSED' }] },
      result: { action: 'fix', reviews: 1, remaining: 1, disarmed: true },
      labels: CLEAN,
      auto: false,
    },
  ],
  [
    'S5 disarm: a write that errors after it landed is no error when the read-back is clean',
    {
      fn: 'step',
      records: [red()],
      script: { fail: [{ on: 'disable', applies: true }] },
      result: { action: 'fix', reviews: 1, remaining: 1, disarmed: true },
      labels: CLEAN,
      auto: false,
    },
  ],
]

/** Attach the oracle's `reviewing` and fill the defaults. */
function prepare(row) {
  const fake = armedPr({ records: row.records, start: row.start, state: row.state, head: row.head, script: row.script })
  const cwd = row.cwd === 'BAD_LANDING' ? badLandingCheckout() : row.cwd
  return { fake, what: { fn: row.fn, opts: row.opts, cwd } }
}

describe('the armed-gate invariant — every exit of landPr and nextReviewStep', () => {
  it.each(ROWS)('%s', async (_name, row) => {
    const { fake, what } = prepare(row)
    const outcome = await exec(what, fake)

    if (row.rejects) {
      expect(outcome.error, 'the call must reject').toBeDefined()
      expect(outcome.error.message).toMatch(row.rejects)
      if (row.errorType) expect(outcome.error).toBeInstanceOf(row.errorType)
      if (row.causeMatches) expect(outcome.error.cause?.message).toMatch(row.causeMatches)
    } else {
      expect(outcome.error, outcome.error?.message).toBeUndefined()
      expect(outcome.result).toEqual(row.result)
      if (row.result.disarmed === undefined) expect(outcome.result).not.toHaveProperty('disarmed')
    }
    expect([...fake.pr.labels].sort()).toEqual([...row.labels].sort())
    expect(fake.pr.autoMerge !== null).toBe(row.auto)
    if (row.none) expect(writesOf(fake)).toEqual([])
    if (row.writesOnly) expect(writesOf(fake).filter((kind) => !row.writesOnly.includes(kind))).toEqual([])
    if (row.noCalls) expect(fake.log).toEqual([])
    expect(holds(fake, outcome, { reviewing: row.reviewing, exempt: row.exempt })).toBe(true)
  })
})

describe('disarmGate — order and independence', () => {
  it('disables auto-merge before it removes the label', async () => {
    const fake = armedPr({ records: [red()] })
    await nextReviewStep('/tmp/wt', PR, { gh: fake.gh })
    expect(writesOf(fake)).toEqual(['disable', 'remove'])
  })

  it('reads the gate back after the writes, and only when it wrote', async () => {
    const armed = armedPr({ records: [red()] })
    await nextReviewStep('/tmp/wt', PR, { gh: armed.gh })
    const kinds = armed.log.map((entry) => entry.kind)
    expect(kinds.slice(kinds.indexOf('disable')).at(-1)).toBe('gate')
    const unarmed = armedPr({ records: [red()], start: 'none' })
    await nextReviewStep('/tmp/wt', PR, { gh: unarmed.gh })
    expect(unarmed.log.filter((entry) => entry.kind === 'gate')).toHaveLength(1)
  })

  it('attempts the label removal even when the disable throws', async () => {
    const fake = armedPr({ records: [red()], script: { fail: [{ on: 'disable' }] } })
    await expect(nextReviewStep('/tmp/wt', PR, { gh: fake.gh })).rejects.toThrow()
    expect(writesOf(fake)).toEqual(['disable', 'remove'])
  })
})

// --- the sweep: every gh call of a scripted run, failed once and moved after -------

/** Scripted runs, each from an armed PR. A move after an arming write, or during the merge-on-green poll, is not exempt. */
const SWEEPS = [
  ['landPr native from a labelled PR', { fn: 'land', opts: NATIVE, records: [approve()], start: 'label' }],
  [
    'landPr native from an armed PR (auto-merge already on)',
    { fn: 'land', opts: NATIVE, records: [approve()], start: 'both' },
  ],
  ['landPr native from an unarmed PR', { fn: 'land', opts: NATIVE, records: [approve()], start: 'none' }],
  ['landPr merge-on-green from a labelled PR', { fn: 'land', opts: MOG, records: [approve()], start: 'label' }],
  ['landPr merge-on-green from an unarmed PR', { fn: 'land', opts: MOG, records: [approve()], start: 'none' }],
  ['landPr refusing a red armed PR', { fn: 'land', opts: NATIVE, records: [approve(), red()], start: 'both' }],
  ['nextReviewStep fix on an armed PR', { fn: 'step', records: [red()], start: 'both' }],
  [
    'nextReviewStep land while reviewing',
    { fn: 'step', opts: { reviewing: true }, reviewing: true, records: [approve()], start: 'both' },
  ],
]

describe('the armed-gate invariant — every gh call of a scripted run', () => {
  it.each(SWEEPS)('%s: a failure at, or a head move after, any call leaves the invariant', async (_name, run) => {
    const baseline = armedPr({ records: run.records, start: run.start })
    const clean = await exec({ fn: run.fn, opts: run.opts }, baseline)
    expect(clean.error, clean.error?.message).toBeUndefined()
    const kinds = baseline.log.map((entry) => entry.kind)
    const gateAt = kinds.indexOf('gate')
    // A move after the last head read cannot be seen once the call returns.
    // An arming write, the merge-on-green poll, and a head read followed by
    // either are not that return.
    const lastRead = run.fn === 'land' ? kinds.lastIndexOf('head') : kinds.length
    const violations = []
    for (let k = 0; k < kinds.length; k++) {
      const failing = armedPr({ records: run.records, start: run.start, script: { failAt: k } })
      const failed = await exec({ fn: run.fn, opts: run.opts }, failing)
      const exempt = failed.error !== undefined && k <= gateAt && writesOf(failing).length === 0
      if (!holds(failing, failed, { reviewing: run.reviewing, exempt })) {
        violations.push(`throw at call ${k} (${kinds[k]}): ${failed.error?.message}`)
      }
      const kind = kinds[k]
      const laterArms = kinds
        .slice(k + 1)
        .some((next) => next === 'add' || next === 'pin' || next === 'events' || next === 'repo')
      const armingWrite = kind === 'add' || kind === 'pin'
      const duringPoll = kind === 'events' || kind === 'repo'
      if (k >= lastRead && !armingWrite && !duringPoll && !laterArms) continue
      const moving = armedPr({ records: run.records, start: run.start, script: { moveAfterCall: k } })
      const moved = await exec({ fn: run.fn, opts: run.opts }, moving)
      if (!holds(moving, moved, { reviewing: run.reviewing })) {
        violations.push(
          `head moved after call ${k} (${kinds[k]}): ${moved.error?.message ?? JSON.stringify(moved.result)}`,
        )
      }
    }
    expect(violations).toEqual([])
  })
})
