import { BASE_NAME } from './epic-naming'
import type { BaseCi } from './epic-types'

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

type CiCheck = { key: string; name: string; status: string; conclusion: string; started: string }
type RankedCiCheck = CiCheck & { rank: string }

function normalizedCheck(node: CheckNode): CiCheck {
  if (node.__typename === 'CheckRun') {
    return {
      key: `${node.checkSuite?.workflowRun?.workflow.name ?? ''}/${node.name}`,
      name: node.name,
      status: (node.status ?? '').toLowerCase(),
      conclusion: (node.conclusion ?? '').toLowerCase(),
      started: node.startedAt ?? '',
    }
  }
  const state = node.state.toLowerCase()
  return {
    key: `/${node.context}`,
    name: node.context,
    status: state === 'pending' || state === 'expected' ? 'in_progress' : 'completed',
    conclusion: state === 'error' ? 'failure' : state,
    started: '',
  }
}

function latestChecks(nodes: CheckNode[]): CiCheck[] {
  const latest = new Map<string, RankedCiCheck>()
  for (const node of nodes) {
    const check = normalizedCheck(node)
    const rank = `${check.status === 'completed' ? 0 : 1}${check.started}`
    const seen = latest.get(check.key)
    if (seen && rank < seen.rank) continue
    latest.set(check.key, { ...check, rank })
  }
  return [...latest.values()]
}

function failedChecks(checks: CiCheck[]): string[] {
  const failed: string[] = []
  for (const check of checks) {
    if (Object.hasOwn(RED, check.conclusion)) failed.push(check.name)
  }
  return failed
}

function pendingChecks(checks: CiCheck[]): string[] {
  const pending: string[] = []
  for (const check of checks) {
    if (Object.hasOwn(RED, check.conclusion)) continue
    if (check.status !== 'completed' || !Object.hasOwn(PASSING, check.conclusion)) {
      pending.push(check.status === 'completed' ? `${check.name}=${check.conclusion}` : check.name)
    }
  }
  return pending
}

function ciState(checks: CiCheck[], failed: string[], pending: string[]): BaseCi['state'] {
  if (failed.length) return 'red'
  if (!checks.length) return 'none'
  return pending.length ? 'pending' : 'green'
}

/**
 * The base HEAD's checks, reduced the way `/ci-watch` reduces a PR's: re-runs of
 * one workflow+name collapse to one (a pending re-run outranks a completed run,
 * then the newest start wins), then the declared `required` names filter, or
 * every check counts. Only failure / timed_out / startup_failure is red; pending,
 * cancelled or none proceed and are reported.
 */
export function classifyBaseCi(nodes: CheckNode[], required: string[]): BaseCi {
  const latest = latestChecks(nodes)
  const checks = required.length === 0 ? latest : latest.filter((check) => required.includes(check.name))
  const failed = failedChecks(checks)
  const pending = pendingChecks(checks)
  return { state: ciState(checks, failed, pending), failed, pending }
}
