/**
 * Declarations for the part of `workflow.js` a TypeScript module imports
 * (`epic-driver.ts`). Keep in step with the JSDoc in `workflow.js`.
 */

type Gh = (cwd: string, args: string[]) => Promise<string>

export declare function readLanding(cwd: string): {
  mode: 'native' | 'merge-on-green'
  required_checks: string[]
}

export declare function disarmReviewedBeforePush(
  cwd: string,
  pr: number | string,
  deps?: { gh?: Gh; push?: () => Promise<void> | void },
): Promise<{ disarmed: true }>

/** At most two automated fixes per PR: red reviews and CI-fixed approved heads (#716). */
export declare const MAX_FIX_ROUNDS: 2

/**
 * The review records by `me` (#716): count, latest verdict and head, how many
 * are `Request changes`, and the sha of every approving record.
 */
export declare function reviewRecords(
  comments: { body: string; author: { login: string } | null }[],
  options: { me: string },
): {
  reviews: number
  verdict: string | null
  head: string | null
  reds: number
  approvedHeads: string[]
}

export type FixCheckRun = {
  name: string
  workflow: string
  actionRun: string | null
  status: string
  conclusion: string
  completed_at: string
  id: number
}

export type FixStatus = {
  context: string
  state: string
  updated_at: string
  id: number
}

export type HeadRuns = {
  checks: FixCheckRun[]
  statuses: FixStatus[]
}

/** `spent` once reds and CI fixes together pass the allowance. Two is still allowed. */
export declare function boundState(input: { reds: number; ciFixes: number }): { fixes: number; spent: boolean }

/** One approved head whose required check failed, once per sha. */
export declare function ciFixCount(
  runsByHead: Record<string, HeadRuns | object[]> | Map<string, HeadRuns>,
  requiredChecks: string[],
): number

/** True when an unread approved head could push the allowance over. */
export declare function unreadCouldSpend(reds: number, approvedHeads: string[]): boolean

/** A 404 on a historical sha. A process exit code is not an HTTP status. */
export declare function isMissingRef(error: unknown): boolean

export declare function declaredRequiredChecks(cwd: string): { declared: boolean; checks: string[] }

export declare function strictRequiredContexts(apiJson: string): string[]

export declare function protectionArgs(owner: string, repo: string, base: string): string[]

export declare function rulesetArgs(owner: string, repo: string, base: string): string[]

export declare function checkRunArgs(owner: string, repo: string, sha: string): string[]

export declare function statusArgs(owner: string, repo: string, sha: string): string[]

export declare function workflowRunArgs(owner: string, repo: string, runId: string): string[]

export declare function parseCheckRuns(raw: string): FixCheckRun[]

export declare function parseCommitStatuses(raw: string): FixStatus[]

export declare function workflowNameFromRun(raw: string): string

export declare function withWorkflowNames(runs: FixCheckRun[], names: Record<string, string>): FixCheckRun[]

export declare function headNeedsStatuses(checks: { name: string }[], required: string[]): boolean

export declare function openPr(
  cwd: string,
  input: { issue: number; branch: string; base: string; title: string; body?: string },
): Promise<{ number: number; status: 'created' | 'existing' }>

export declare function landPr(
  cwd: string,
  pr: number | string,
): Promise<{ status: string; mode?: string; watch?: string; reason?: string; disarmed?: true }>

export declare function applyCiWatchExit(
  cwd: string,
  pr: number | string,
  code: number,
  opts?: { mode?: string },
): Promise<{ status: string }>
