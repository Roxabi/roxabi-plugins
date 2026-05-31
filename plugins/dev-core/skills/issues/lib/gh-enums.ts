export const CHECK_STATUS_STATES = ['QUEUED', 'REQUESTED', 'IN_PROGRESS', 'COMPLETED', 'WAITING', 'PENDING'] as const
export type CheckStatusState = (typeof CHECK_STATUS_STATES)[number]

export const CHECK_CONCLUSION_STATES = [
  'ACTION_REQUIRED',
  'TIMED_OUT',
  'CANCELLED',
  'FAILURE',
  'SUCCESS',
  'NEUTRAL',
  'SKIPPED',
  'STARTUP_FAILURE',
  'STALE',
] as const
export type CheckConclusionState = (typeof CHECK_CONCLUSION_STATES)[number]

export const STATUS_STATES = ['EXPECTED', 'ERROR', 'FAILURE', 'PENDING', 'SUCCESS'] as const
export type StatusState = (typeof STATUS_STATES)[number]

export const PULL_REQUEST_STATES = ['OPEN', 'CLOSED', 'MERGED'] as const
export type PullRequestState = (typeof PULL_REQUEST_STATES)[number]

export const MERGEABLE_STATES = ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] as const
export type MergeableState = (typeof MERGEABLE_STATES)[number]

export const VERCEL_STATES = ['QUEUED', 'BUILDING', 'ERROR', 'INITIALIZING', 'READY', 'CANCELED'] as const
export type VercelState = (typeof VERCEL_STATES)[number]

export const WORKFLOW_STATUSES = ['queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending'] as const
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number]

export const WORKFLOW_CONCLUSIONS = [
  'success',
  'failure',
  'neutral',
  'cancelled',
  'skipped',
  'timed_out',
  'action_required',
  'stale',
] as const
export type WorkflowConclusion = (typeof WORKFLOW_CONCLUSIONS)[number]

// ── Coercion guards ───────────────────────────────────────────────────────────

const inSet = <T extends string>(set: readonly T[], v: string): v is T => (set as readonly string[]).includes(v)

// CICheck.status is `CheckStatusState | StatusState | ''` — unknown → ''
export function asCheckStatusState(v: string): CheckStatusState | StatusState | '' {
  return inSet(CHECK_STATUS_STATES, v) || inSet(STATUS_STATES, v) ? (v as CheckStatusState | StatusState) : ''
}

// CICheck.conclusion is `CheckConclusionState | ''` — unknown → ''
export function asCheckConclusionState(v: string): CheckConclusionState | '' {
  return inSet(CHECK_CONCLUSION_STATES, v) ? v : ''
}

// MergeableState already has 'UNKNOWN' as its natural sentinel — unknown → 'UNKNOWN'
export function asMergeableState(v: string): MergeableState {
  return inSet(MERGEABLE_STATES, v) ? v : 'UNKNOWN'
}

// PullRequestState has no empty member — field widened to `PullRequestState | ''`, unknown → ''
export function asPullRequestState(v: string): PullRequestState | '' {
  return inSet(PULL_REQUEST_STATES, v) ? v : ''
}

// WorkflowStatus has no empty member — field widened to `WorkflowStatus | ''`, unknown → ''
export function asWorkflowStatus(v: string): WorkflowStatus | '' {
  return inSet(WORKFLOW_STATUSES, v) ? v : ''
}

// WorkflowRun.conclusion is `WorkflowConclusion | null` — null or unknown → null
export function asWorkflowConclusion(v: string | null): WorkflowConclusion | null {
  return v != null && inSet(WORKFLOW_CONCLUSIONS, v) ? v : null
}
