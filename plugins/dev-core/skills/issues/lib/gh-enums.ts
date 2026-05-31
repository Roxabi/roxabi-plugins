export type CheckStatusState = 'QUEUED' | 'REQUESTED' | 'IN_PROGRESS' | 'COMPLETED' | 'WAITING' | 'PENDING'

export type CheckConclusionState =
  | 'ACTION_REQUIRED'
  | 'TIMED_OUT'
  | 'CANCELLED'
  | 'FAILURE'
  | 'SUCCESS'
  | 'NEUTRAL'
  | 'SKIPPED'
  | 'STARTUP_FAILURE'
  | 'STALE'

export type StatusState = 'EXPECTED' | 'ERROR' | 'FAILURE' | 'PENDING' | 'SUCCESS'

export type PullRequestState = 'OPEN' | 'CLOSED' | 'MERGED'

export type MergeableState = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'

export type VercelState = 'QUEUED' | 'BUILDING' | 'ERROR' | 'INITIALIZING' | 'READY' | 'CANCELED'

export type WorkflowStatus = 'queued' | 'in_progress' | 'completed' | 'waiting' | 'requested' | 'pending'

export type WorkflowConclusion =
  | 'success'
  | 'failure'
  | 'neutral'
  | 'cancelled'
  | 'skipped'
  | 'timed_out'
  | 'action_required'
  | 'stale'
  | 'startup_failure'
