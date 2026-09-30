/**
 * The epic goal's transition contract (#620, ADR-024 §1). Pure: every fact the
 * decision needs arrives as a parameter, gathered from GitHub and git by
 * `epic-driver.ts`, so a goal session resumes from GitHub state, not from memory.
 */
import { epicDiffRange } from './epic-close'

// ── Claims: which ticket a branch or a commit belongs to ──────────────────────

/** Branch convention: `<type>/<issue>-<slug>`. The ticket ends the segment. */
const BRANCH_TICKET = /^[^/]+\/(\d+)(?:-|$)/

/** The issue a branch name claims, or `null` when it claims none. */
export function ticketOfBranch(branch: string | null | undefined): number | null {
  if (!branch) return null
  const match = BRANCH_TICKET.exec(branch)
  return match ? Number(match[1]) : null
}

export function resolveTicketBranch(branch: string, children: number[]): { ticket: number } | { error: string } {
  const ticket = ticketOfBranch(branch)
  if (ticket === null) return { error: 'no ticket' }
  if (!children.includes(ticket)) return { error: 'foreign ticket' }
  return { ticket }
}

/** `feat(x): subject (#N)`, and the `Revert "… (#N)"` git writes for it. */
const SUBJECT_TICKET = /\(#(\d+)\)"*\s*$/

export function ticketOfSubject(subject: string): number | null {
  const match = SUBJECT_TICKET.exec(subject)
  return match ? Number(match[1]) : null
}

/** A commit that claims no ticket, or another one, is foreign: fail closed. */
export function refuseForeignCommits(
  commits: { sha: string; ticket: number | null }[],
  ticket: number,
): { ok: true } | { error: string } {
  const foreign = commits.find((commit) => commit.ticket !== ticket)
  if (foreign) return { error: `foreign commit ${foreign.sha}` }
  return { ok: true }
}

// ── Scope and branch naming ───────────────────────────────────────────────────

/** Markdown headings outside fenced code. */
function headings(body: string): string[] {
  const out: string[] = []
  let fenced = false
  for (const line of body.split('\n')) {
    if (/^ {0,3}(```|~~~)/.test(line)) fenced = !fenced
    else if (!fenced && /^ {0,3}#{1,6}\s/.test(line)) out.push(line)
  }
  return out
}

/**
 * Framed enough to start unattended: a `size:` label, an acceptance/criteria
 * heading, and no heading containing "needs framing" (the §4 not-framed marker).
 */
export function hasScope(child: { labels: string[]; body: string }): boolean {
  const titles = headings(child.body)
  return (
    child.labels.some((label) => label.startsWith('size:')) &&
    titles.some((title) => /acceptance|criteria/i.test(title)) &&
    !titles.some((title) => /needs framing/i.test(title))
  )
}

const BRANCH_TYPES: Record<string, true> = {
  feat: true,
  fix: true,
  docs: true,
  test: true,
  chore: true,
  ci: true,
  perf: true,
  refactor: true,
}

/** `<type>/<N>-<slug>` from the Conventional title (`bug` label → `fix`, else `feat`). */
export function branchFor(child: { number: number; title: string; labels: string[] }): string {
  const match = /^(\w+)(?:\([^)]*\))?!?:\s*(.*)$/.exec(child.title)
  const prefix = match?.[1]?.toLowerCase() ?? ''
  const type = Object.hasOwn(BRANCH_TYPES, prefix) ? prefix : child.labels.includes('bug') ? 'fix' : 'feat'
  const slug = (match ? (match[2] ?? '') : child.title)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .split('-')
    .filter(Boolean)
    .slice(0, 6)
    .join('-')
    .slice(0, 48)
    .replace(/-+$/, '')
  return `${type}/${child.number}${slug ? `-${slug}` : ''}`
}

// ── Goal gate ─────────────────────────────────────────────────────────────────

export const RUN_ID = /^[a-z0-9]{8}$/
const BASE_NAME = /^[A-Za-z0-9._/-]+$/

export type Goal = { status?: string | null; objective?: string | null } | null | undefined

/**
 * The run and base a goal authorizes for `epic`, or `null`. Only an **active**
 * goal counts (paused, budget-limited, dropped, complete do not), and its
 * objective must name exactly this epic as `/feature #E`, one `run=<id>` and
 * one `base=<branch>`.
 */
export function goalRun(goal: Goal, epic: number): { run: string; base: string } | null {
  if (goal?.status !== 'active') return null
  const text = goal.objective ?? ''
  const epics = [...text.matchAll(/\/feature #(\d+)\b/g)].map((match) => Number(match[1]))
  if (epics.length === 0 || epics.some((named) => named !== epic)) return null
  const runs = [...text.matchAll(/(?:^|[\s(])run=([^\s)]+)/g)].map((match) => match[1] ?? '')
  const bases = [...text.matchAll(/(?:^|[\s(])base=([^\s)]+)/g)].map((match) => match[1] ?? '')
  const [run] = runs
  const [base] = bases
  if (runs.length !== 1 || bases.length !== 1 || !run || !base) return null
  if (!RUN_ID.test(run) || !BASE_NAME.test(base) || base.includes('..')) return null
  return { run, base }
}

export function objectiveText(epic: number, run: string, base: string): string {
  return [
    `Deliver epic #${epic} (/feature #${epic} run=${run} base=${base}).`,
    'Read skill://feature, section Epic goal, and call its driver (epic-driver.ts next) before every ticket;',
    'follow the one action it returns and never rely on memory of earlier tickets.',
    'Ticket stop: report it, the driver records it, dependents are skipped, independent children continue.',
    'Shared-state stop (base CI red, dirty tree between tickets, landing or tracker failure, post-merge hook failure,',
    'final review still blocking after its fix round, no progress): report, then goal drop.',
    `Complete when every child is closed or merged into ${base}, the final epic review is clean,`,
    'and the post-merge hook succeeded or was skipped: report, then goal complete.',
  ].join(' ')
}

// ── Markers: machine lines on GitHub ─────────────────────────────────────────

export type MarkerKind = 'goal-stop' | 'epic-review' | 'epic-fix' | 'post-merge' | 'goal-report'

const FIELD_VALUE = /^[A-Za-z0-9._-]+$/

export function formatMarker(kind: MarkerKind, fields: Record<string, string> = {}): string {
  const pairs = Object.entries(fields).map(([key, value]) => {
    if (!/^[a-z]+$/.test(key) || !FIELD_VALUE.test(value)) throw new Error(`marker ${kind}: bad field ${key}=${value}`)
    return ` ${key}=${value}`
  })
  return `<!-- omp-build:${kind}${pairs.join('')} -->`
}

/**
 * The fields of a `kind` marker on the **first line** of `body`, or `null`. A
 * marker quoted further down a comment — a review, a report — is not a marker.
 */
export function readMarker(body: string, kind: MarkerKind): Record<string, string> | null {
  const first = body.split('\n', 1)[0]?.trim() ?? ''
  const match = /^<!--\s*omp-build:([a-z-]+)((?:\s+[a-z]+=[A-Za-z0-9._-]+)*)\s*-->$/.exec(first)
  if (!match || match[1] !== kind) return null
  const fields: Record<string, string> = {}
  for (const pair of (match[2] ?? '').trim().split(/\s+/).filter(Boolean)) {
    const at = pair.indexOf('=')
    fields[pair.slice(0, at)] = pair.slice(at + 1)
  }
  return fields
}

const SHA = /^[0-9a-f]{40}$/

export function parseGoalStop(body: string): { run: string; reason: string } | null {
  const fields = readMarker(body, 'goal-stop')
  if (!fields?.run || !fields.reason || !RUN_ID.test(fields.run)) return null
  return { run: fields.run, reason: fields.reason }
}

export function parseEpicReview(body: string): EpicReview | null {
  const fields = readMarker(body, 'epic-review')
  if (!fields?.run || !RUN_ID.test(fields.run)) return null
  if (fields.verdict !== 'clean' && fields.verdict !== 'blocking') return null
  const parts = (fields.range ?? '').split('..')
  const [from, to] = parts
  if (parts.length !== 2 || !from || !to || !SHA.test(from) || !SHA.test(to)) return null
  return { run: fields.run, verdict: fields.verdict, range: `${from}..${to}` }
}

export function parsePostMerge(body: string): HookRecord | null {
  const fields = readMarker(body, 'post-merge')
  if (!fields?.run || !RUN_ID.test(fields.run) || !SHA.test(fields.sha ?? '')) return null
  const result = fields.result
  if (result !== 'started' && result !== 'ok' && result !== 'skipped' && result !== 'failed') return null
  return { run: fields.run, result, sha: fields.sha as string }
}

// ── Stops ─────────────────────────────────────────────────────────────────────

/** Report, record a goal-stop marker, skip dependents, continue independents. */
export const TICKET_STOPS = [
  'review-bound',
  'proof-blocked',
  'foreign-commit',
  'branch-mismatch',
  'no-scope',
  'timeout',
  'ci-cancelled',
  'ci-blocked',
  'stopped',
  'closed',
] as const

/** Disarm every in-flight PR, report, `goal({op:"drop"})`. */
export const SHARED_STOPS = [
  'base-ci-red',
  'dirty-tree',
  'watch-failed',
  'bad-landing',
  'no-required-checks',
  'evaluate-only',
  'auto-merge-failed',
  'tracker-unresolvable',
  'hook-failed',
  'final-review-blocking',
  'unknown-land-status',
  'driver-error',
] as const

/** A spent review bound stays stopped across runs; every other ticket stop is retried by a new run. */
export const STICKY_STOPS: readonly string[] = ['review-bound']

export type TicketStop = (typeof TICKET_STOPS)[number]
export type SharedStop = (typeof SHARED_STOPS)[number]

export function stopClass(reason: string): 'ticket' | 'shared' | 'no-progress' | null {
  if ((TICKET_STOPS as readonly string[]).includes(reason)) return 'ticket'
  if ((SHARED_STOPS as readonly string[]).includes(reason)) return 'shared'
  if (reason === 'no-progress') return 'no-progress'
  return null
}

/**
 * What a `landPr` / `applyCiWatchExit` status means under a goal. `timeout` is a
 * ticket stop, never a re-attach. An unknown status fails closed as shared.
 */
export function landOutcome(
  status: string,
): { next: 'watch' | 'confirm' | 'reopen' } | { stop: TicketStop | SharedStop; class: 'ticket' | 'shared' } {
  switch (status) {
    case 'watching':
      return { next: 'watch' }
    case 'merged':
      return { next: 'confirm' }
    case 'ci-failed':
      return { next: 'reopen' }
    case 'timeout':
    case 'ci-cancelled':
    case 'ci-blocked':
    case 'stopped':
    case 'closed':
      return { stop: status, class: 'ticket' }
    case 'review-stopped':
      return { stop: 'review-bound', class: 'ticket' }
    case 'watch-failed':
    case 'bad-landing':
    case 'no-required-checks':
    case 'evaluate-only':
    case 'auto-merge-failed':
      return { stop: status, class: 'shared' }
    default:
      return { stop: 'unknown-land-status', class: 'shared' }
  }
}

// ── Facts ─────────────────────────────────────────────────────────────────────

export type PrFacts = {
  number: number
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  base: string
  head: string
  headSha: string
  mergedAt: string | null
  mergeSha: string | null
  /** First parent of the merge commit: the base the child landed on. */
  baseSha: string | null
  /** `reviewed` label or native auto-merge on. */
  armed: boolean
  /** The review loop has stopped on this PR (`interpretReviewHistory` in `workflow.js`). */
  exhausted: boolean
}

export type BranchFacts = {
  name: string
  local: boolean
  /** The local tip when the branch is local, else the origin tip. */
  tip: string
  /** `refs/remotes/origin/<name>`, or `null` when it was never pushed. */
  remoteTip: string | null
  /** First commit in `origin/<base>..` the local or origin tip that does not claim the child, or `null`. */
  foreign: string | null
  /** Another worktree that has it checked out, or `null`. */
  elsewhere: string | null
}

export type ChildFacts = {
  number: number
  title: string
  state: 'OPEN' | 'CLOSED'
  labels: string[]
  body: string
  /** The body's first line is the epic-fix marker, written by this account. */
  epicFix: boolean
  /** `repo` is set only when the blocker lives in another repository. */
  blockedBy: { number: number; state: 'OPEN' | 'CLOSED'; repo?: string }[]
  stops: { run: string; reason: string }[]
  prs: PrFacts[]
  branches: BranchFacts[]
}

export type BaseCi = { state: 'red' | 'green' | 'pending' | 'none'; failed: string[]; pending: string[] }
export type EpicReview = { run: string; verdict: 'clean' | 'blocking'; range: string }
export type HookRecord = { run: string; result: 'started' | 'ok' | 'skipped' | 'failed'; sha: string }

export type Facts = {
  epic: number
  run: string
  base: string
  /** `refs/remotes/origin/<base>` after the fetch. */
  baseSha: string
  tree: { clean: boolean; branch: string | null }
  baseCi: BaseCi
  children: ChildFacts[]
  /** Oldest first. */
  reviews: EpicReview[]
  /** Oldest first. */
  hooks: HookRecord[]
}

export type Report = {
  merged: number[]
  /** Closed without a PR merged into the base. */
  closed: number[]
  stopped: { ticket: number; reason: string; sticky: boolean }[]
  skipped: { ticket: number; blockers: number[] }[]
  baseCi: BaseCi
}

export type Step = { reason: string; report: Report } & (
  | { action: 'start'; ticket: number; branch: string }
  | { action: 'resume'; ticket: number; branch: string; pr: PrFacts | null }
  | { action: 'stop'; ticket: number; stop: TicketStop }
  | { action: 'final-review'; stage: 'review' | 'fix-ticket'; range: string }
  | { action: 'post-merge' }
  | { action: 'complete' }
  | { action: 'drop'; stop: SharedStop | 'no-progress' }
)

// ── Base: which branch, and is it green ───────────────────────────────────────

/**
 * The base from `.dev/stack.yml` `release.model`: `trunk` → the default branch
 * (`defaultBranch` is only asked then), `staging-train` → `staging`. Anything
 * else is refused: a guessed base would branch every child from the wrong place.
 */
export function baseFromStack(doc: unknown, defaultBranch: () => string): { base: string } | { error: string } {
  const release = doc && typeof doc === 'object' && 'release' in doc ? doc.release : null
  const model = release && typeof release === 'object' && 'model' in release ? release.model : undefined
  if (model === 'staging-train') return { base: 'staging' }
  if (model !== 'trunk') return { error: `release.model is ${JSON.stringify(model)}, not trunk or staging-train` }
  const base = defaultBranch().trim()
  if (!BASE_NAME.test(base) || base.includes('..'))
    return { error: `default branch ${JSON.stringify(base)} is not a branch name` }
  return { base }
}

/** One node of a commit's `statusCheckRollup`, as GitHub returns it. */
export type CheckNode =
  | {
      __typename: 'CheckRun'
      name: string
      status: string | null
      conclusion: string | null
      startedAt: string | null
      checkSuite: { workflowRun: { workflow: { name: string } } | null } | null
    }
  | { __typename: 'StatusContext'; context: string; state: string }

const RED: Record<string, true> = { failure: true, timed_out: true, startup_failure: true }
const PASSING: Record<string, true> = { success: true, skipped: true, neutral: true }

/**
 * The base HEAD's checks, reduced the way `/ci-watch` reduces a PR's: re-runs of
 * one workflow+name collapse to one (a pending re-run outranks a completed run,
 * then the newest start wins), then the declared `required` names filter, or
 * every check counts. Only failure / timed_out / startup_failure is red; pending,
 * cancelled or none proceed and are reported.
 */
export function classifyBaseCi(nodes: CheckNode[], required: string[]): BaseCi {
  const latest = new Map<string, { name: string; status: string; conclusion: string; rank: string }>()
  for (const node of nodes) {
    const state = node.__typename === 'StatusContext' ? node.state.toLowerCase() : ''
    const check =
      node.__typename === 'CheckRun'
        ? {
            key: `${node.checkSuite?.workflowRun?.workflow.name ?? ''}/${node.name}`,
            name: node.name,
            status: (node.status ?? '').toLowerCase(),
            conclusion: (node.conclusion ?? '').toLowerCase(),
            started: node.startedAt ?? '',
          }
        : {
            key: `/${node.context}`,
            name: node.context,
            status: state === 'pending' || state === 'expected' ? 'in_progress' : 'completed',
            conclusion: state === 'error' ? 'failure' : state,
            started: '',
          }
    const rank = `${check.status === 'completed' ? 0 : 1}${check.started}`
    const seen = latest.get(check.key)
    if (!seen || rank >= seen.rank) latest.set(check.key, { ...check, rank })
  }
  const checks = [...latest.values()].filter((check) => !required.length || required.includes(check.name))
  const failed = checks.filter((c) => Object.hasOwn(RED, c.conclusion)).map((c) => c.name)
  const pending = checks
    .filter((c) => !Object.hasOwn(RED, c.conclusion))
    .filter((c) => c.status !== 'completed' || !Object.hasOwn(PASSING, c.conclusion))
    .map((c) => (c.status === 'completed' ? `${c.name}=${c.conclusion}` : c.name))
  const state = failed.length ? 'red' : !checks.length ? 'none' : pending.length ? 'pending' : 'green'
  return { state, failed, pending }
}

// ── Classification ───────────────────────────────────────────────────────────

/** The PR that landed this child on the base: MERGED, into `base`, from a branch claiming it. */
export function mergedPr(child: ChildFacts, base: string): PrFacts | null {
  return (
    child.prs.find(
      (pr) => pr.state === 'MERGED' && pr.base === base && ticketOfBranch(pr.head) === child.number && pr.mergeSha,
    ) ?? null
  )
}

/** Closed, or merged into the base (staging-train leaves a merged child open). */
export function isDone(child: ChildFacts, base: string): boolean {
  return child.state === 'CLOSED' || mergedPr(child, base) !== null
}

function stopOf(child: ChildFacts, run: string): { reason: string; sticky: boolean } | null {
  const sticky = child.stops.find((stop) => STICKY_STOPS.includes(stop.reason))
  if (sticky) return { reason: sticky.reason, sticky: true }
  if (child.prs.some((pr) => pr.state === 'OPEN' && pr.exhausted)) return { reason: 'review-bound', sticky: true }
  const current = child.stops.filter((stop) => stop.run === run).at(-1)
  return current ? { reason: current.reason, sticky: false } : null
}

function openBlockers(child: ChildFacts, byNumber: Map<number, ChildFacts>, base: string): number[] {
  return child.blockedBy
    .filter((blocker) => {
      const sibling = blocker.repo ? undefined : byNumber.get(blocker.number)
      return sibling ? !isDone(sibling, base) : blocker.state === 'OPEN'
    })
    .map((blocker) => blocker.number)
}

/** Kahn over in-epic edges between `pending` children, ties by number. */
function topological(pending: ChildFacts[]): { order: number[]; rest: number[] } {
  const inSet = new Set(pending.map((child) => child.number))
  const edges = new Map(
    pending.map((child) => [
      child.number,
      child.blockedBy.filter((b) => !b.repo && inSet.has(b.number)).map((b) => b.number),
    ]),
  )
  const order: number[] = []
  const placed = new Set<number>()
  for (;;) {
    const ready = pending
      .map((child) => child.number)
      .filter((n) => !placed.has(n) && (edges.get(n) ?? []).every((b) => placed.has(b)))
      .sort((a, b) => a - b)
    const next = ready[0]
    if (next === undefined) break
    order.push(next)
    placed.add(next)
  }
  return { order, rest: pending.map((child) => child.number).filter((n) => !placed.has(n)) }
}

export function summarize(facts: Facts): Report {
  const byNumber = new Map(facts.children.map((child) => [child.number, child]))
  const report: Report = { merged: [], closed: [], stopped: [], skipped: [], baseCi: facts.baseCi }
  for (const child of [...facts.children].sort((a, b) => a.number - b.number)) {
    if (mergedPr(child, facts.base)) report.merged.push(child.number)
    else if (child.state === 'CLOSED') report.closed.push(child.number)
    else {
      const stop = stopOf(child, facts.run)
      if (stop) report.stopped.push({ ticket: child.number, ...stop })
      else {
        const blockers = openBlockers(child, byNumber, facts.base)
        if (blockers.length) report.skipped.push({ ticket: child.number, blockers })
      }
    }
  }
  return report
}

/** Local branches of merged children whose tip is exactly what merged: safe to delete. */
export function mergedLocalBranches(facts: Facts): { ticket: number; branch: string }[] {
  const out: { ticket: number; branch: string }[] = []
  for (const child of facts.children) {
    const pr = mergedPr(child, facts.base)
    if (!pr) continue
    for (const branch of child.branches) {
      if (branch.local && !branch.elsewhere && branch.tip === pr.headSha) {
        out.push({ ticket: child.number, branch: branch.name })
      }
    }
  }
  return out
}

// ── The objective ─────────────────────────────────────────────────────────────

/**
 * The `/goal` objective for an epic. Closed or merged children leave the order
 * and satisfy their dependents. An open blocker outside the epic reports the
 * child (and its in-epic dependents) as blocked; `cycle` is reserved for a real
 * cycle among the rest. Any open child without scope → no objective.
 */
export function generateObjective(input: {
  epic: number
  run: string
  base: string
  children: ChildFacts[]
}): { objective: string; order: number[]; blocked: { ticket: number; blockers: number[] }[] } | { error: string } {
  const { epic, run, base, children } = input
  if (!RUN_ID.test(run)) return { error: `bad run id ${run}` }
  const open = children.filter((child) => !isDone(child, base))
  const missing = open.filter((child) => !hasScope(child)).map((child) => child.number)
  if (missing.length) return { error: `missing scope: ${missing.join(', ')}` }

  const byNumber = new Map(children.map((child) => [child.number, child]))
  const blocked = new Map<number, number[]>()
  for (const child of open) {
    const outside = child.blockedBy
      .filter((blocker) => (blocker.repo || !byNumber.has(blocker.number)) && blocker.state === 'OPEN')
      .map((blocker) => blocker.number)
    if (outside.length) blocked.set(child.number, outside)
  }
  for (let grew = true; grew; ) {
    grew = false
    for (const child of open) {
      if (blocked.has(child.number)) continue
      const via = child.blockedBy.filter((b) => !b.repo && blocked.has(b.number)).map((b) => b.number)
      if (via.length) {
        blocked.set(child.number, via)
        grew = true
      }
    }
  }
  const { order, rest } = topological(open.filter((child) => !blocked.has(child.number)))
  if (rest.length) return { error: `cycle: ${rest.join(', ')}` }
  return {
    objective: objectiveText(epic, run, base),
    order,
    blocked: [...blocked].map(([ticket, blockers]) => ({ ticket, blockers })).sort((a, b) => a.ticket - b.ticket),
  }
}

// ── The driver's decision ─────────────────────────────────────────────────────

/**
 * The one next action of a goal run, from GitHub and git state alone.
 *
 * `start` / `resume` pick one actionable child: HEAD's own child first, then an
 * open PR, then an existing branch, then `blocked_by` order. `stop` is a ticket
 * stop the facts themselves prove (no scope, branch mismatch, foreign commit);
 * the driver records it and asks again, so a session only ever receives the
 * other six actions.
 */
export function nextStep(facts: Facts): Step {
  const report = summarize(facts)
  const { base, run } = facts
  const byNumber = new Map(facts.children.map((child) => [child.number, child]))
  const pending = facts.children.filter((child) => !isDone(child, base))
  const actionable = pending.filter((child) => !stopOf(child, run) && openBlockers(child, byNumber, base).length === 0)

  if (actionable.length) {
    const { order } = topological(actionable)
    const ranked = order.map((n) => byNumber.get(n) as ChildFacts)
    const target =
      ranked.find((child) => ticketOfBranch(facts.tree.branch) === child.number) ??
      ranked.find((child) => child.prs.some((pr) => pr.state === 'OPEN')) ??
      ranked.find((child) => child.branches.length > 0) ??
      (ranked[0] as ChildFacts)
    const ticket = target.number

    if (!facts.tree.clean && ticketOfBranch(facts.tree.branch) !== ticket) {
      return {
        action: 'drop',
        stop: 'dirty-tree',
        reason: `the epic worktree is dirty on ${facts.tree.branch ?? 'a detached HEAD'} between tickets`,
        report,
      }
    }
    if (facts.baseCi.state === 'red') {
      return {
        action: 'drop',
        stop: 'base-ci-red',
        reason: `base ${base} is red: ${facts.baseCi.failed.join(', ')}`,
        report,
      }
    }
    if (!hasScope(target)) {
      return {
        action: 'stop',
        ticket,
        stop: 'no-scope',
        reason: `#${ticket} has no size label, no acceptance heading, or a needs-framing heading`,
        report,
      }
    }
    const open = target.prs.filter((pr) => pr.state === 'OPEN')
    if (open.length > 1) {
      return {
        action: 'stop',
        ticket,
        stop: 'branch-mismatch',
        reason: `#${ticket} has ${open.length} open PRs: ${open.map((pr) => `#${pr.number}`).join(', ')}`,
        report,
      }
    }
    const pr = open[0] ?? null
    if (pr && (pr.base !== base || ticketOfBranch(pr.head) !== ticket)) {
      return {
        action: 'stop',
        ticket,
        stop: 'branch-mismatch',
        reason: `PR #${pr.number} is ${pr.head} → ${pr.base}, not a #${ticket} branch into ${base}`,
        report,
      }
    }
    const names = [...new Set(target.branches.map((branch) => branch.name))]
    if (!pr && names.length > 1) {
      return {
        action: 'stop',
        ticket,
        stop: 'branch-mismatch',
        reason: `several branches claim #${ticket}: ${names.join(', ')}`,
        report,
      }
    }
    const name = pr?.head ?? names[0] ?? null
    if (name === null) {
      return { action: 'start', ticket, branch: branchFor(target), reason: `#${ticket} is next in order`, report }
    }
    const branch = target.branches.find((candidate) => candidate.name === name)
    if (!branch) {
      return {
        action: 'stop',
        ticket,
        stop: 'branch-mismatch',
        reason: `PR #${pr?.number} head ${name} is not on origin`,
        report,
      }
    }
    if (branch.elsewhere) {
      return {
        action: 'stop',
        ticket,
        stop: 'branch-mismatch',
        reason: `${name} is checked out in another worktree, ${branch.elsewhere}`,
        report,
      }
    }
    if (pr && pr.headSha !== branch.remoteTip) {
      return {
        action: 'stop',
        ticket,
        stop: 'branch-mismatch',
        reason: `PR #${pr.number} head ${pr.headSha} is not origin/${name} (${branch.remoteTip ?? 'absent'})`,
        report,
      }
    }
    if (branch.foreign) {
      return {
        action: 'stop',
        ticket,
        stop: 'foreign-commit',
        reason: `${name} carries ${branch.foreign}, which does not claim #${ticket}`,
        report,
      }
    }
    return {
      action: 'resume',
      ticket,
      branch: name,
      pr,
      reason: pr ? `#${ticket} has open PR #${pr.number}` : `#${ticket} has branch ${name}`,
      report,
    }
  }

  if (pending.length) {
    return {
      action: 'drop',
      stop: 'no-progress',
      reason: `no actionable child while ${pending.map((child) => `#${child.number}`).join(', ')} remain open`,
      report,
    }
  }

  const merged = facts.children
    .map((child) => ({ child, pr: mergedPr(child, base) }))
    .filter((entry): entry is { child: ChildFacts; pr: PrFacts } => entry.pr !== null)
    .sort((a, b) => (a.pr.mergedAt ?? '').localeCompare(b.pr.mergedAt ?? ''))
  if (!merged.length) return { action: 'complete', reason: 'every child closed and none merged', report }
  const first = merged[0]?.pr
  if (!first?.baseSha) {
    return { action: 'drop', stop: 'driver-error', reason: `PR #${first?.number} has no merge base`, report }
  }
  const diff = epicDiffRange(
    merged.map(({ child, pr }) => ({ number: child.number, baseSha: pr.baseSha ?? '', mergeSha: pr.mergeSha })),
  )
  if ('error' in diff) return { action: 'drop', stop: 'driver-error', reason: diff.error, report }
  const end = diff.range.split('..')[1]
  const review = facts.reviews.filter((entry) => entry.range.split('..')[1] === end).at(-1)
  if (!review) {
    return { action: 'final-review', stage: 'review', range: diff.range, reason: `no review of ${diff.range}`, report }
  }
  if (review.verdict === 'blocking') {
    if (!facts.children.some((child) => child.epicFix)) {
      return {
        action: 'final-review',
        stage: 'fix-ticket',
        range: diff.range,
        reason: 'the final review is blocking and its one fix round is unspent',
        report,
      }
    }
    return {
      action: 'drop',
      stop: 'final-review-blocking',
      reason: 'the final review is still blocking after its fix round',
      report,
    }
  }

  const ours = facts.hooks.filter((hook) => hook.run === run).at(-1)
  if (ours?.result === 'failed')
    return { action: 'drop', stop: 'hook-failed', reason: 'the post-merge hook failed', report }
  if (ours?.result === 'started') {
    return { action: 'drop', stop: 'hook-failed', reason: 'the post-merge hook started and left no result', report }
  }
  if (ours) return { action: 'complete', reason: `post-merge hook ${ours.result}`, report }
  const same = facts.hooks.find(
    (hook) => hook.sha === facts.baseSha && (hook.result === 'ok' || hook.result === 'skipped'),
  )
  if (same) return { action: 'complete', reason: `post-merge hook ${same.result} at ${facts.baseSha}`, report }
  return { action: 'post-merge', reason: `final review clean at ${end}`, report }
}
