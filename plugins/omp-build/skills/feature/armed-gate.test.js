import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { commentPageArgs, landPr, nextReviewStep } from './workflow.js'

/**
 * The armed-gate invariant (#713), delivered again by #744. An OPEN PR is armed (`reviewed`
 * label or auto-merge) only when the latest review record approves the current head, the
 * review bound is not spent, and no review of that head is running. #744's refusal policy is
 * stronger on one exit: a native `no-required-checks` refusal disarms an already-armed OPEN
 * gate even at a stable, approved head (explicit or discovered-empty contexts), because an
 * empty discovery is not proof that protection is absent.
 *
 * One stateful fake PR, shared by `landPr` and `nextReviewStep`. Every exit of both after the
 * gate read is a row of the table below; the sweeps at the end make each gh call of a scripted
 * run fail once, move the head after it, and fail while the head moves, so a missed exit shows
 * up as a violation of the oracle. The oracle is written here from the fake's final state,
 * not from `workflow.js`. The fake also answers the resolver's repo / base / protection / rules
 * reads, so native runs without declared checks go through the real discovery control flow.
 *
 * Out of this table on purpose (#731): an unreadable head after a refused pin
 * (`pinRefused`) still returns `auto-merge-failed` / `armed: false` and leaves the gate it found.
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
    return { [GATE_FIELDS]: 'gate', headRefOid: 'head', labels: 'labels', baseRefName: 'base' }[args[4]] ?? 'unexpected'
  }
  if (same(args, ['pr', 'merge', String(PR), '--disable-auto'])) return 'disable'
  if (same(args, ['pr', 'edit', String(PR), '--remove-label', 'reviewed'])) return 'remove'
  if (same(args, ['pr', 'edit', String(PR), '--add-label', 'reviewed'])) return 'add'
  if (args[0] === 'pr' && args[1] === 'merge' && args[3] === '--auto' && args[5] === '--match-head-commit') return 'pin'
  if (same(args, ['repo', 'view', '--json', 'nameWithOwner'])) return 'repo'
  if (same(args, ['api', 'repos/acme/app/branches/main/protection/required_status_checks'])) return 'protection'
  if (same(args, ['api', 'repos/acme/app/rules/branches/main'])) return 'rules'
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
 * @typedef {{ fail?: Fail[], moves?: Move[], failAt?: number, moveAfterCall?: number, moveBeforeCall?: number, events?: 'normal' | 'none' }} Script
 *   `moveBeforeCall`: the head moves immediately before the call at that log index runs (and may fail).
 * @typedef {{ classic?: string[], rules?: string[] }} Found
 *   The required contexts the base's protection and rulesets answer with.
 */

/**
 * @param {{ records?: ReturnType<typeof approve>[], start?: keyof typeof ARMED, state?: string, head?: string, script?: Script, found?: Found }} spec
 */
function armedPr({ records = [], start = 'both', state = 'OPEN', head = HEAD, script = {}, found = {} } = {}) {
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
      case 'base':
        return JSON.stringify({ baseRefName: 'main' })
      case 'protection':
        return JSON.stringify({ contexts: found.classic ?? [] })
      case 'rules':
        return JSON.stringify(
          (found.rules ?? []).length
            ? [
                {
                  type: 'required_status_checks',
                  parameters: { required_status_checks: found.rules.map((context) => ({ context })) },
                },
              ]
            : [],
        )
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
    if (script.moveBeforeCall === index) pr.head = MOVED
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

/** The write that clears each arm. */
const CLEARED_BY = { 'auto-merge': 'disable', 'the reviewed label': 'remove' }

/** Was each of these arms's own clearing write attempted — by any call, applied or not? */
const attempted = (fake, names) => names.every((name) => fake.log.some((entry) => entry.kind === CLEARED_BY[name]))

/**
 * The invariant at exit: unarmed, or allowed by the records at the fake's current head, or
 * the call said exactly what stays armed. `exempt`: a read that failed before any gate was
 * read — the issue's explicit exception. `strict`: the stronger #744 policy of a native
 * refusal for want of required checks — the records' approval of this head buys nothing, only
 * an unarmed gate or a truthful report of what stays armed.
 *
 * A report of what stays armed, or that the read-back could not tell, is accepted only when the
 * writes that clear every arm still on the PR were really attempted: words over a gate that
 * nothing tried to clear are not an honest report.
 */
function holds(fake, outcome, { reviewing = false, exempt = false, strict = false } = {}) {
  if (fake.pr.state !== 'OPEN') return true
  const names = armedNames(fake)
  if (names.length === 0 || exempt) return true
  if (!strict && mayBeArmed(fake, reviewing)) return true
  if (!attempted(fake, names)) return false
  const message = outcome.error?.message ?? outcome.result?.error ?? ''
  if (/could not be read back; auto-merge and reviewed may stay armed/.test(message)) return true
  const said = message.match(/stays armed — (auto-merge and the reviewed label|auto-merge|the reviewed label)/)
  return said !== null && said[1] === names.join(' and ')
}

/**
 * A disarm claim is true of the fake's PR: a result that says `disarmed: true`, or that the gate
 * was disarmed, follows a clearing write that was really attempted and leaves nothing armed on an
 * OPEN PR. (A CLOSED PR has no OPEN gate left to claim over.)
 */
function truthful(fake, outcome) {
  const claimed = outcome.result?.disarmed === true || /the gate was disarmed/.test(outcome.result?.error ?? '')
  if (!claimed) return true
  if (!fake.log.some((entry) => entry.kind === 'disable' || entry.kind === 'remove')) return false
  return fake.pr.state !== 'OPEN' || armedNames(fake).length === 0
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

// ---- landPr native: a refusal for want of required checks disarms (#744) ---------

/** The caller says there are no required checks. */
const EXPLICIT_EMPTY = { landing: { mode: 'native', required_checks: [] }, requiredContexts: [] }
/** Nothing declared, nothing passed: the resolver's repo / base / protection / rules reads decide. */
const DISCOVERED = { landing: { mode: 'native', required_checks: [] } }
const SOURCES = [
  ['explicit empty contexts', EXPLICIT_EMPTY],
  ['discovered-empty contexts', DISCOVERED],
]
/** What a disarm writes from each armed start, in the order it writes them. */
const START_WRITES = { both: ['disable', 'remove'], label: ['remove'], auto: ['disable'] }
const REFUSED = { status: 'no-required-checks', disarmed: true }
const WATCHING = { status: 'watching', mode: 'native', watch: expect.any(String) }
/** A stable, approved head: only the policy — not the records — can explain an unarmed end state. */
const NRC = { fn: 'land', records: [approve()], strict: true }

/** A discovered resolver read that ends the refusal's lookup: what each of its calls does on failure. */
const LOOKUP_FAILURES = [
  ['the protection read throws', [{ on: 'protection', error: 'HTTP 403' }]],
  ['the rules read throws', [{ on: 'rules', error: 'HTTP 404' }]],
  [
    'both reads throw',
    [
      { on: 'protection', error: 'HTTP 403' },
      { on: 'rules', error: 'HTTP 403' },
    ],
  ],
  ['the repo read throws', [{ on: 'repo', error: 'HTTP 502' }]],
  ['the repo read is not JSON', [{ on: 'repo', answer: 'not json' }]],
  [
    'protection and rules answer garbage',
    [
      { on: 'protection', answer: 'not json' },
      { on: 'rules', answer: '{}' },
    ],
  ],
]

/** Disarm failures, over a gate armed by both (the clean state the fake ends in is in the row). */
const DISARM_FAULTS = [
  [
    'the disable fails alone → throws naming auto-merge; the label is removed anyway',
    { fail: [{ on: 'disable' }] },
    { rejects: stays('auto-merge'), labels: CLEAN, auto: true },
  ],
  [
    'the label removal fails alone → throws naming the label; auto-merge is off',
    { fail: [{ on: 'remove' }] },
    { rejects: stays('the reviewed label'), labels: REVIEWED, auto: false },
  ],
  [
    'both writes fail → one error naming both, with both write errors',
    {
      fail: [
        { on: 'disable', error: 'no disable' },
        { on: 'remove', error: 'no remove' },
      ],
    },
    {
      rejects: /stays armed — auto-merge and the reviewed label[\s\S]*no disable[\s\S]*no remove/,
      labels: REVIEWED,
      auto: true,
    },
  ],
  [
    'the disable lands, then throws → the read-back finds nothing armed: disarmed',
    { fail: [{ on: 'disable', applies: true }] },
    { result: REFUSED, labels: CLEAN, auto: false },
  ],
  [
    'the removal lands, then throws → disarmed',
    { fail: [{ on: 'remove', applies: true }] },
    { result: REFUSED, labels: CLEAN, auto: false },
  ],
  [
    'both writes land, then throw → disarmed',
    {
      fail: [
        { on: 'disable', applies: true },
        { on: 'remove', applies: true },
      ],
    },
    { result: REFUSED, labels: CLEAN, auto: false },
  ],
  [
    'the disable answers and changes nothing → the read-back finds auto-merge still armed',
    { fail: [{ on: 'disable', answer: '' }] },
    { rejects: stays('auto-merge'), labels: CLEAN, auto: true },
  ],
  [
    'the removal answers and changes nothing → the read-back finds the label still armed',
    { fail: [{ on: 'remove', answer: '' }] },
    { rejects: stays('the reviewed label'), labels: REVIEWED, auto: false },
  ],
  ...GATE_READ_FAILURES.map(([how, fail]) => [
    `the read-back ${how} → may stay armed, no claim`,
    { fail: [{ on: 'gate', nth: 2, ...fail }] },
    { rejects: /could not be read back; auto-merge and reviewed may stay armed/, labels: CLEAN, auto: false },
  ]),
  [
    'the PR merges while it is disarmed → throws, no claim',
    { moves: [{ when: 'after', on: 'remove', state: 'MERGED' }] },
    { rejects: /merged while being disarmed/, labels: CLEAN, auto: false },
  ],
  [
    'the PR closes while it is disarmed → no OPEN gate is left: disarmed',
    { moves: [{ when: 'after', on: 'remove', state: 'CLOSED' }] },
    { result: REFUSED, labels: CLEAN, auto: false },
  ],
]

/** Read-backs that cannot confirm a disarm — the fake itself is already clear (CLEAN, no auto-merge). */
const clear = { headRefOid: HEAD, state: 'OPEN', labels: [{ name: OTHER_LABEL }], autoMergeRequest: null }
const BAD_READBACKS = [
  ['no state', { headRefOid: HEAD, labels: clear.labels, autoMergeRequest: null }],
  ['an unknown state', { ...clear, state: 'INVALID' }],
  ['a lower-case state', { ...clear, state: 'open' }],
  ['an OPEN gate with no autoMergeRequest field', { headRefOid: HEAD, state: 'OPEN', labels: clear.labels }],
  ['an autoMergeRequest that is neither null nor an object', { ...clear, autoMergeRequest: 'none' }],
  ['a label with no name', { ...clear, labels: [{}] }],
  ['a label whose name is not a string', { ...clear, labels: [{ name: 5 }] }],
]

const NO_REQUIRED_CHECKS = [
  // every armed start, both sources, a stable approved head: disarmed, and only said so by a read-back
  ...SOURCES.flatMap(([source, opts]) =>
    Object.entries(START_WRITES).map(([start, writes]) => [
      `N0 no-required-checks, ${source}, armed by ${start}, stable approved head → disarmed, and says so`,
      { ...NRC, opts, start, result: REFUSED, labels: CLEAN, auto: false, writes },
    ]),
  ),
  // the head moves around any lookup of the discovery: the refusal is the same
  ...['repo', 'base', 'protection', 'rules'].flatMap((kind) =>
    ['before', 'after'].map((when) => [
      `N0 no-required-checks, discovered: the head moves ${when} the ${kind} read → still refused and disarmed`,
      {
        ...NRC,
        opts: DISCOVERED,
        start: 'both',
        script: { moves: [{ when, on: kind, head: MOVED }] },
        result: REFUSED,
        labels: CLEAN,
        auto: false,
        writes: ['disable', 'remove'],
      },
    ]),
  ),
  // the lookup fails: an empty answer is not proof, so the gate is disarmed all the same
  ...LOOKUP_FAILURES.flatMap(([how, fail]) =>
    Object.entries(START_WRITES).flatMap(([start, writes]) => [
      [
        `N0 no-required-checks, discovered: ${how}, armed by ${start} → refused and disarmed`,
        { ...NRC, opts: DISCOVERED, start, script: { fail }, result: REFUSED, labels: CLEAN, auto: false, writes },
      ],
      [
        `N0 no-required-checks, discovered: ${how} while the head moves, armed by ${start} → refused and disarmed`,
        {
          ...NRC,
          opts: DISCOVERED,
          start,
          script: { fail, moves: [{ when: 'before', on: fail[0].on, head: MOVED }] },
          result: REFUSED,
          labels: CLEAN,
          auto: false,
          writes,
        },
      ],
    ]),
  ),
  // one source empty or failing does not hide a requirement from the other
  ...[
    ['classic protection names ci, the rules read throws', { classic: ['ci'] }, [{ on: 'rules', error: 'HTTP 404' }]],
    ['rulesets name ci, the protection read throws', { rules: ['ci'] }, [{ on: 'protection', error: 'HTTP 403' }]],
    ['protection and rulesets both name ci', { classic: ['ci'], rules: ['ci'] }, []],
    ['protection names ci, rulesets are empty', { classic: ['ci'] }, []],
    ['rulesets name ci, protection is empty', { rules: ['ci'] }, []],
  ].map(([how, found, fail]) => [
    `N0 discovered contexts: ${how} → the landing goes on and arms the PR`,
    {
      fn: 'land',
      opts: DISCOVERED,
      records: [approve()],
      start: 'none',
      found,
      script: { fail },
      result: WATCHING,
      labels: REVIEWED,
      auto: true,
    },
  ]),
  // discovered contexts, head moves before a lookup: the pre-pin re-read refuses and disarms
  ...['repo', 'base', 'protection', 'rules'].map((kind) => [
    `N0 discovered contexts: the head moves before the ${kind} read → refused as head-moved, disarmed`,
    {
      fn: 'land',
      opts: DISCOVERED,
      records: [approve()],
      start: 'label',
      found: { classic: ['ci'] },
      script: { moves: [{ when: 'before', on: kind, head: MOVED }] },
      result: { status: 'not-approved', reviews: 1, reason: 'head-moved', disarmed: true },
      labels: CLEAN,
      auto: false,
      writesOnly: ['remove'],
    },
  ]),
  // the disarm itself cannot finish, or is not confirmed
  ...SOURCES.flatMap(([source, opts]) =>
    DISARM_FAULTS.map(([how, script, expected]) => [
      `N0 no-required-checks, ${source}: ${how}`,
      { ...NRC, opts, start: 'both', script, ...expected },
    ]),
  ),
  // a read-back that cannot confirm: invalid or incomplete state is never a claim
  ...SOURCES.flatMap(([source, opts]) =>
    BAD_READBACKS.map(([how, body]) => [
      `N0 no-required-checks, ${source}: the read-back has ${how} → could not be read back, no claim`,
      {
        ...NRC,
        opts,
        start: 'both',
        script: { fail: [{ on: 'gate', nth: 2, answer: JSON.stringify(body) }] },
        rejects: /could not be read back; auto-merge and reviewed may stay armed/,
        labels: CLEAN,
        auto: false,
      },
    ]),
  ),
  // a read-back that still shows an arm is a refusal to claim, naming it
  ...SOURCES.flatMap(([source, opts]) => [
    [
      `N0 no-required-checks, ${source}: the read-back still shows auto-merge → stays armed — auto-merge`,
      {
        ...NRC,
        opts,
        start: 'both',
        script: {
          fail: [
            { on: 'gate', nth: 2, answer: JSON.stringify({ ...clear, autoMergeRequest: { mergeMethod: 'MERGE' } }) },
          ],
        },
        rejects: stays('auto-merge'),
        labels: CLEAN,
        auto: false,
      },
    ],
    [
      `N0 no-required-checks, ${source}: the read-back still shows the label → stays armed — the reviewed label`,
      {
        ...NRC,
        opts,
        start: 'both',
        script: {
          fail: [{ on: 'gate', nth: 2, answer: JSON.stringify({ ...clear, labels: [{ name: 'reviewed' }] }) }],
        },
        rejects: stays('the reviewed label'),
        labels: CLEAN,
        auto: false,
      },
    ],
  ]),
  // nothing armed, or no OPEN gate: a no-op that claims nothing and writes nothing
  ...SOURCES.flatMap(([source, opts]) => [
    [
      `N0 no-required-checks, ${source}: nothing armed → no writes, no claim`,
      { ...NRC, opts, start: 'none', result: { status: 'no-required-checks' }, labels: CLEAN, auto: false, none: true },
    ],
    ...['CLOSED', 'MERGED'].map((state) => [
      `N0 no-required-checks, ${source}: the PR is already ${state} → nothing written, no claim`,
      {
        ...NRC,
        opts,
        start: 'both',
        state,
        result: { status: 'no-required-checks' },
        labels: REVIEWED,
        auto: true,
        none: true,
      },
    ]),
  ]),
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
  ...NO_REQUIRED_CHECKS,

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
  ...[
    ['the labels view throws', { error: 'gh: HTTP 502' }, /^gh: HTTP 502$/, /gh: HTTP 502/],
    ['the labels view is not JSON', { answer: 'not json' }, /JSON|json/, /JSON|json/],
    ['the labels view has no label list', { answer: JSON.stringify({ labels: 'reviewed' }) }, /label/, /label/],
  ].flatMap(([how, fail, rejects, cause]) => [
    [
      `M1 merge-on-green: ${how} → the armed gate is disarmed, the read error is rethrown`,
      {
        fn: 'land',
        opts: MOG,
        records: [approve()],
        script: { fail: [{ on: 'labels', ...fail }] },
        rejects,
        labels: CLEAN,
        auto: false,
      },
    ],
    [
      `M1 merge-on-green: ${how} while the head moves → disarmed, the read error is rethrown`,
      {
        fn: 'land',
        opts: MOG,
        records: [approve()],
        script: { fail: [{ on: 'labels', ...fail }], moves: [{ when: 'before', on: 'labels', head: MOVED }] },
        rejects,
        labels: CLEAN,
        auto: false,
      },
    ],
    [
      `M1 merge-on-green: ${how} and auto-merge cannot be disabled → stays armed, after the read error`,
      {
        fn: 'land',
        opts: MOG,
        records: [approve()],
        script: { fail: [{ on: 'labels', ...fail }, { on: 'disable' }] },
        rejects: /stays armed — auto-merge(?! and)[\s\S]*— after: /,
        causeMatches: cause,
        labels: CLEAN,
        auto: true,
      },
    ],
  ]),
  ...[
    ['the first head read throws', { error: 'injected' }, /^injected$/],
    ['the first head read is not JSON', { answer: 'not json' }, /no JSON|JSON/],
  ].flatMap(([how, fail, rejects]) => [
    [
      `M2 merge-on-green: ${how} → the armed gate is disarmed, the read error is rethrown`,
      {
        fn: 'land',
        opts: MOG,
        records: [approve()],
        script: { fail: [{ on: 'head', ...fail }] },
        rejects,
        labels: CLEAN,
        auto: false,
      },
    ],
    [
      `M2 merge-on-green: ${how} while the head moves → disarmed, the read error is rethrown`,
      {
        fn: 'land',
        opts: MOG,
        records: [approve()],
        script: { fail: [{ on: 'head', ...fail }], moves: [{ when: 'before', on: 'head', head: MOVED }] },
        rejects,
        labels: CLEAN,
        auto: false,
      },
    ],
  ]),
  [
    'M2 merge-on-green: the first head read throws and the label cannot be removed → stays armed, after the read error',
    {
      fn: 'land',
      opts: MOG,
      records: [approve()],
      script: { fail: [{ on: 'head' }, { on: 'remove' }] },
      rejects: /stays armed — the reviewed label[\s\S]*— after: injected/,
      causeMatches: /^injected$/,
      labels: REVIEWED,
      auto: false,
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
    'M4 merge-on-green: adding the label throws after the old one was removed → the head is still reviewed, so the raw error does not escape',
    {
      fn: 'land',
      opts: MOG,
      records: [approve()],
      script: { fail: [{ on: 'add' }] },
      result: {
        status: 'watch-failed',
        error: expect.stringContaining('labeled reviewed event'),
      },
      labels: CLEAN,
      auto: true,
    },
  ],
  [
    'M4 merge-on-green: the label write applies then throws, and the head moved → disarmed, the raw error does not escape',
    {
      fn: 'land',
      opts: MOG,
      records: [approve()],
      start: 'none',
      script: {
        fail: [{ on: 'add', applies: true }],
        moves: [{ when: 'before', on: 'head', nth: 2, head: MOVED }],
      },
      result: { status: 'not-approved', reviews: 1, reason: 'head-moved', disarmed: true },
      labels: CLEAN,
      auto: false,
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
  ...[
    ['the first head read throws', { error: 'injected' }, /^injected$/],
    ['the first head read is not JSON', { answer: 'not json' }, /no JSON|JSON/],
  ].flatMap(([how, fail, rejects]) => [
    [
      `N1 native: ${how} → the armed gate is disarmed, the read error is rethrown`,
      {
        fn: 'land',
        opts: NATIVE,
        records: [approve()],
        start: 'label',
        script: { fail: [{ on: 'head', ...fail }] },
        rejects,
        labels: CLEAN,
        auto: false,
        writesOnly: ['remove'],
      },
    ],
    [
      `N1 native: ${how} while the head moves → disarmed, the read error is rethrown`,
      {
        fn: 'land',
        opts: NATIVE,
        records: [approve()],
        start: 'both',
        script: { fail: [{ on: 'head', ...fail }], moves: [{ when: 'before', on: 'head', head: MOVED }] },
        rejects,
        labels: CLEAN,
        auto: false,
      },
    ],
  ]),
  [
    'N1 native: the first head read throws and the label cannot be removed → stays armed, after the read error',
    {
      fn: 'land',
      opts: NATIVE,
      records: [approve()],
      start: 'label',
      script: { fail: [{ on: 'head' }, { on: 'remove' }] },
      rejects: /stays armed — the reviewed label[\s\S]*— after: injected/,
      causeMatches: /^injected$/,
      labels: REVIEWED,
      auto: false,
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
    'N3 native: the pin fails and the head cannot be read back → auto-merge-failed, the gate as it was (the explicit #731 limit, kept as it is)',
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
    'N3 native: the pin enables auto-merge then throws, the head moved, and the fresh gate read fails → disarmed from what the call wrote',
    {
      fn: 'land',
      opts: NATIVE,
      records: [approve()],
      start: 'none',
      script: {
        fail: [
          { on: 'pin', applies: true, error: 'HTTP 502' },
          { on: 'gate', nth: 2 },
        ],
        moves: [{ when: 'before', on: 'head', nth: 2, head: MOVED }],
      },
      result: { status: 'not-approved', reviews: 1, reason: 'head-moved', disarmed: true },
      labels: CLEAN,
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
    'N4 native: unarmed opening snapshot, the pin enables auto-merge then throws already enabled, the disable fails, and the head moved → does not claim the gate was disarmed while auto-merge is on',
    {
      fn: 'land',
      opts: NATIVE,
      records: [approve()],
      start: 'none',
      script: {
        fail: [
          { on: 'pin', error: 'already enabled', applies: true },
          { on: 'disable', times: 2 },
        ],
        moves: [{ when: 'before', on: 'head', nth: 2, head: MOVED }],
      },
      result: {
        status: 'auto-merge-failed',
        armed: true,
        error: expect.stringMatching(/stays armed — auto-merge(?! and)/),
      },
      labels: CLEAN,
      auto: true,
    },
  ],
  [
    'N4 native: already enabled, the disable fails, the head moved, and the disarm writes succeed → gate was disarmed',
    {
      fn: 'land',
      opts: NATIVE,
      records: [approve()],
      start: 'none',
      script: {
        fail: [{ on: 'pin', error: 'already enabled', applies: true }, { on: 'disable' }],
        moves: [{ when: 'before', on: 'head', nth: 2, head: MOVED }],
      },
      result: {
        status: 'auto-merge-failed',
        armed: false,
        error: 'head moved after --disable-auto failed; the gate was disarmed',
      },
      labels: CLEAN,
      auto: false,
    },
  ],
  [
    'N4 native: already enabled, the disable fails, the head cannot be read, and the disarm writes succeed → gate was disarmed',
    {
      fn: 'land',
      opts: NATIVE,
      records: [approve()],
      start: 'none',
      script: {
        fail: [{ on: 'pin', error: 'already enabled', applies: true }, { on: 'disable' }, { on: 'head', nth: 2 }],
      },
      result: {
        status: 'auto-merge-failed',
        armed: false,
        error: expect.stringMatching(/^head unreadable after --disable-auto failed; the gate was disarmed — /),
      },
      labels: CLEAN,
      auto: false,
    },
  ],
  [
    'N4 native: a snapshot that was not OPEN, already enabled, the disable fails, and the head moved → nothing to disarm; the fresh read names what is on',
    {
      fn: 'land',
      opts: NATIVE,
      records: [approve()],
      start: 'both',
      state: 'CLOSED',
      script: {
        fail: [{ on: 'disable' }],
        moves: [{ when: 'before', on: 'head', nth: 2, head: MOVED }],
      },
      result: {
        status: 'auto-merge-failed',
        armed: true,
        error: expect.stringMatching(/^PR 7 stays armed — auto-merge and the reviewed label \(--disable-auto failed: /),
      },
      labels: REVIEWED,
      auto: true,
    },
  ],
  [
    'N4 native: a snapshot that was not OPEN, the pin throws already enabled without applying, the disable fails, and the head cannot be read → the fresh read finds nothing armed, and no disarm is claimed',
    {
      fn: 'land',
      opts: NATIVE,
      records: [approve()],
      start: 'none',
      state: 'CLOSED',
      script: {
        fail: [{ on: 'pin', error: 'already enabled' }, { on: 'disable' }, { on: 'head', nth: 2 }],
      },
      result: {
        status: 'auto-merge-failed',
        armed: false,
        error: expect.stringMatching(
          /^PR 7 is CLOSED with nothing armed after --disable-auto failed; the head could not be read — /,
        ),
      },
      labels: CLEAN,
      auto: false,
    },
  ],
  [
    'N4 native: a snapshot that was not OPEN, already enabled, the disable fails, the head moved, and the fresh read throws → could not be read back, armed',
    {
      fn: 'land',
      opts: NATIVE,
      records: [approve()],
      start: 'none',
      state: 'CLOSED',
      script: {
        fail: [{ on: 'pin', error: 'already enabled' }, { on: 'disable' }, { on: 'gate', nth: 2 }],
        moves: [{ when: 'before', on: 'head', nth: 2, head: MOVED }],
      },
      result: {
        status: 'auto-merge-failed',
        armed: true,
        error: expect.stringMatching(/^PR 7 could not be read back; auto-merge and reviewed may stay armed — /),
      },
      labels: CLEAN,
      auto: false,
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
    'N5 native: the head re-read after the disable throws → the gate is disarmed, the read error is rethrown',
    {
      fn: 'land',
      opts: NATIVE,
      records: [approve()],
      start: 'both',
      script: { fail: [{ on: 'head', nth: 2 }] },
      rejects: /^injected$/,
      labels: CLEAN,
      auto: false,
    },
  ],
  [
    'N5 native: the head re-read after the disable throws while the head moves → disarmed, the read error is rethrown',
    {
      fn: 'land',
      opts: NATIVE,
      records: [approve()],
      start: 'both',
      script: { fail: [{ on: 'head', nth: 2 }], moves: [{ when: 'before', on: 'head', nth: 2, head: MOVED }] },
      rejects: /^injected$/,
      labels: CLEAN,
      auto: false,
    },
  ],
  [
    'N5 native: the head re-read after the disable throws and the label cannot be removed → stays armed, after the read error',
    {
      fn: 'land',
      opts: NATIVE,
      records: [approve()],
      start: 'both',
      script: { fail: [{ on: 'head', nth: 2 }, { on: 'remove' }] },
      rejects: /stays armed — the reviewed label[\s\S]*— after: injected/,
      causeMatches: /^injected$/,
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
    'N9 native: the label write throws after a verified pin → the head is still reviewed, so the raw error does not escape',
    {
      fn: 'land',
      opts: NATIVE,
      records: [approve()],
      start: 'none',
      script: { fail: [{ on: 'add' }] },
      result: { status: 'watching', mode: 'native', watch: expect.any(String) },
      labels: CLEAN,
      auto: true,
    },
  ],
  [
    'N9 native: the label write applies then throws, and the head moved → disarmed, the raw error does not escape',
    {
      fn: 'land',
      opts: NATIVE,
      records: [approve()],
      start: 'none',
      script: {
        fail: [{ on: 'add', applies: true }],
        moves: [{ when: 'before', on: 'head', nth: 3, head: MOVED }],
      },
      result: { status: 'not-approved', reviews: 1, reason: 'head-moved', disarmed: true },
      labels: CLEAN,
      auto: false,
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
  ...BAD_READBACKS.map(([how, body]) => [
    `S5 disarm: the read-back has ${how} → could not be read back, no claim`,
    {
      fn: 'step',
      records: [red()],
      script: { fail: [{ on: 'gate', nth: 2, answer: JSON.stringify(body) }] },
      rejects: /could not be read back; auto-merge and reviewed may stay armed/,
      labels: CLEAN,
      auto: false,
    },
  ]),
  [
    'S5 disarm: a disable that answers and changes nothing → the read-back names auto-merge',
    {
      fn: 'step',
      records: [red()],
      script: { fail: [{ on: 'disable', answer: '' }] },
      rejects: stays('auto-merge'),
      labels: CLEAN,
      auto: true,
    },
  ],
  [
    'S5 disarm: a removal that answers and changes nothing → the read-back names the label',
    {
      fn: 'step',
      records: [red()],
      script: { fail: [{ on: 'remove', answer: '' }] },
      rejects: stays('the reviewed label'),
      labels: REVIEWED,
      auto: false,
    },
  ],
]

/** Attach the oracle's `reviewing` and fill the defaults. */
function prepare(row) {
  const fake = armedPr({
    records: row.records,
    start: row.start,
    state: row.state,
    head: row.head,
    script: row.script,
    found: row.found,
  })
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
    if (row.writes) expect(writesOf(fake)).toEqual(row.writes)
    if (row.writesOnly) expect(writesOf(fake).filter((kind) => !row.writesOnly.includes(kind))).toEqual([])
    if (row.noCalls) expect(fake.log).toEqual([])
    expect(holds(fake, outcome, { reviewing: row.reviewing, exempt: row.exempt, strict: row.strict })).toBe(true)
    expect(truthful(fake, outcome)).toBe(true)
  })
})

describe('disarmGate — order and independence', () => {
  it('disables auto-merge before it removes the label', async () => {
    const fake = armedPr({ records: [red()] })
    await nextReviewStep('/tmp/wt', PR, { gh: fake.gh })
    expect(writesOf(fake)).toEqual(['disable', 'remove'])
  })

  it('attempts the label removal even when the disable throws', async () => {
    const fake = armedPr({ records: [red()], script: { fail: [{ on: 'disable' }] } })
    await expect(nextReviewStep('/tmp/wt', PR, { gh: fake.gh })).rejects.toThrow()
    expect(writesOf(fake)).toEqual(['disable', 'remove'])
  })
})

describe('the oracle itself', () => {
  it('does not take a read-back or stays-armed report over a gate no clearing write was tried on', () => {
    const fake = armedPr({ records: [red()], start: 'both' })
    const unknown = new Error('disarmGate: PR 7 could not be read back; auto-merge and reviewed may stay armed — x')
    const named = new Error('disarmGate: PR 7 stays armed — auto-merge and the reviewed label')
    expect(holds(fake, { error: unknown })).toBe(false)
    expect(holds(fake, { error: named })).toBe(false)
  })

  it('takes the same reports once every arm still on the PR had its own write tried', async () => {
    const fake = armedPr({
      records: [red()],
      start: 'both',
      script: { fail: [{ on: 'disable' }, { on: 'remove' }] },
    })
    const outcome = await exec({ fn: 'step' }, fake)
    expect(outcome.error?.message).toMatch(stays('auto-merge and the reviewed label'))
    expect(holds(fake, outcome)).toBe(true)
  })

  it('does not take a report over an arm whose own write was never tried', async () => {
    const fake = armedPr({ records: [red()], start: 'both' })
    await fake.gh('/tmp/wt', ['pr', 'edit', String(PR), '--remove-label', 'reviewed'])
    expect(holds(fake, { error: new Error(`PR ${PR} stays armed — auto-merge`) })).toBe(false)
  })

  it('does not let the records excuse an armed PR under the strict refusal policy', () => {
    const fake = armedPr({ records: [approve()], start: 'both' })
    expect(holds(fake, { result: {} })).toBe(true)
    expect(holds(fake, { result: {} }, { strict: true })).toBe(false)
  })

  it('takes a disarm claim only after a clearing write, over a PR with nothing armed', async () => {
    const unwritten = armedPr({ records: [red()], start: 'none' })
    expect(truthful(unwritten, { result: { disarmed: true } })).toBe(false)
    expect(truthful(unwritten, { result: { status: 'x' } })).toBe(true)
    const still = armedPr({ records: [red()], start: 'both', script: { fail: [{ on: 'disable', answer: '' }] } })
    await still.gh('/tmp/wt', ['pr', 'merge', String(PR), '--disable-auto'])
    expect(truthful(still, { result: { disarmed: true } })).toBe(false)
    const cleared = armedPr({ records: [red()], start: 'both' })
    await nextReviewStep('/tmp/wt', PR, { gh: cleared.gh })
    expect(truthful(cleared, { result: { disarmed: true } })).toBe(true)
  })
})

// --- the sweeps: every gh call of a scripted run, failed once, moved after, and both at once --------

/**
 * Scripted runs, each from an armed PR. A move after an arming write, or during the merge-on-green poll
 * or the required-checks lookup, is not exempt. `strict` (and `outcome`): the #744 policy — a native
 * refusal for want of required checks leaves nothing armed whatever the records say of the head.
 * `exhaustive`: no head read follows the gate there, so a move is tried after every call anyway.
 */
const SWEEPS = [
  ['landPr native from a labelled PR', { fn: 'land', opts: NATIVE, records: [approve()], start: 'label' }],
  [
    'landPr native from an armed PR (auto-merge already on)',
    { fn: 'land', opts: NATIVE, records: [approve()], start: 'both' },
  ],
  ['landPr native from an unarmed PR', { fn: 'land', opts: NATIVE, records: [approve()], start: 'none' }],
  [
    'landPr native, discovered non-empty contexts, from a labelled PR',
    { fn: 'land', opts: DISCOVERED, found: { classic: ['ci'] }, records: [approve()], start: 'label' },
  ],
  [
    'landPr native, discovered non-empty contexts, from an armed PR (auto-merge already on)',
    { fn: 'land', opts: DISCOVERED, found: { rules: ['ci'] }, records: [approve()], start: 'both' },
  ],
  ['landPr merge-on-green from a labelled PR', { fn: 'land', opts: MOG, records: [approve()], start: 'label' }],
  ['landPr merge-on-green from an armed PR', { fn: 'land', opts: MOG, records: [approve()], start: 'both' }],
  ['landPr merge-on-green from an unarmed PR', { fn: 'land', opts: MOG, records: [approve()], start: 'none' }],
  ['landPr refusing a red armed PR', { fn: 'land', opts: NATIVE, records: [approve(), red()], start: 'both' }],
  ['nextReviewStep fix on an armed PR', { fn: 'step', records: [red()], start: 'both' }],
  [
    'nextReviewStep land while reviewing',
    { fn: 'step', opts: { reviewing: true }, reviewing: true, records: [approve()], start: 'both' },
  ],
  ...['both', 'label', 'auto'].flatMap((start) =>
    SOURCES.map(([source, opts]) => [
      `landPr native refusing for want of required checks (${source}) from a PR armed by ${start}`,
      { fn: 'land', opts, records: [approve()], start, strict: true, exhaustive: true, outcome: REFUSED },
    ]),
  ),
]

/** The reads after the gate that a head move and a failure can hit together. */
const PAIRABLE = new Set(['labels', 'head', 'repo', 'protection', 'rules', 'events', 'gate'])

describe('the armed-gate invariant — every gh call of a scripted run', () => {
  it.each(SWEEPS)(
    '%s: a failure at, a head move after, or both at, any call leaves the invariant',
    async (_name, run) => {
      const spec = { records: run.records, start: run.start, found: run.found }
      const baseline = armedPr(spec)
      const clean = await exec({ fn: run.fn, opts: run.opts }, baseline)
      expect(clean.error, clean.error?.message).toBeUndefined()
      if (run.outcome) {
        expect(clean.result).toEqual(run.outcome)
        expect([...baseline.pr.labels]).toEqual(CLEAN)
        expect(baseline.pr.autoMerge).toBeNull()
      }
      const kinds = baseline.log.map((entry) => entry.kind)
      const gateAt = kinds.indexOf('gate')
      // A move after the last head read cannot be seen once the call returns.
      // An arming write, the merge-on-green poll, the required-checks lookup, and a head read followed
      // by either are not that return.
      const lastRead = run.exhaustive ? -2 : run.fn === 'land' ? kinds.lastIndexOf('head') : kinds.length
      const LOOKUP = new Set(['events', 'repo', 'base', 'protection', 'rules'])
      const violations = []
      const check = (fake, outcome, label, exempt = false) => {
        if (!holds(fake, outcome, { reviewing: run.reviewing, exempt, strict: run.strict })) {
          violations.push(`${label}: ${outcome.error?.message ?? JSON.stringify(outcome.result)}`)
        }
        if (!truthful(fake, outcome)) violations.push(`${label}: a disarm claim over a PR that is not disarmed`)
      }
      for (let k = 0; k < kinds.length; k++) {
        const kind = kinds[k]
        // A failed base read falls to the real `detectPrincipal` (git in the cwd); not a fake's to answer.
        if (kind !== 'base') {
          const failing = armedPr({ ...spec, script: { failAt: k } })
          const failed = await exec({ fn: run.fn, opts: run.opts }, failing)
          const exempt = failed.error !== undefined && k <= gateAt && writesOf(failing).length === 0
          check(failing, failed, `throw at call ${k} (${kind})`, exempt)
        }
        const laterArms = kinds.slice(k + 1).some((next) => next === 'add' || next === 'pin' || LOOKUP.has(next))
        const armingWrite = kind === 'add' || kind === 'pin'
        if (k >= lastRead && !armingWrite && !LOOKUP.has(kind) && !laterArms) {
          // nothing to move after
        } else {
          const moving = armedPr({ ...spec, script: { moveAfterCall: k } })
          const moved = await exec({ fn: run.fn, opts: run.opts }, moving)
          check(moving, moved, `head moved after call ${k} (${kind})`)
        }
        if (kind !== 'base' && k > gateAt && PAIRABLE.has(kind)) {
          const both = armedPr({ ...spec, script: { failAt: k, moveBeforeCall: k } })
          const hit = await exec({ fn: run.fn, opts: run.opts }, both)
          check(both, hit, `throw and head moved at call ${k} (${kind})`)
        }
      }
      expect(violations).toEqual([])
    },
  )
})
