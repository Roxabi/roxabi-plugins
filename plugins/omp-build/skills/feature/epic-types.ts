import type { ActionInputs } from '../../engine/action-input-schema.ts'
import type { ExternalRecordRef } from '../../engine/record-references.ts'
import type { UwCompletion } from '../../engine/uw-completion-types.ts'
import type { UwDiagnostic } from '../../engine/uw-diagnostics.ts'
import type { SpecSnapshot, UwTier } from '../../engine/uw-spec.ts'
import type { AcceptedOwnSpec } from '../../engine/workflow-accepted-spec-types.ts'
import type { ParentIntegrationRead } from '../../roxabi/uw-parent-current-integration.ts'
import type { InitialMandateReadiness } from './epic-initial-mandate'
import type { SharedStop, TicketStop } from './epic-stops'

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
  /** The review bound is spent on this PR (`reviewRecords` in `workflow-records.js`). */
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

export type FramedOwnUw = {
  status: 'framed'
  role: 'parent' | 'leaf'
  snapshot: SpecSnapshot
  tier: UwTier
  graphComplete: true
  identityAllocations: readonly { id: string; allocationRef: ExternalRecordRef }[]
}

export type AcceptedOwnUw = {
  status: 'accepted'
  role: 'parent' | 'leaf'
  accepted: AcceptedOwnSpec
  /** The complete graph was observed in this gather, not inferred from an issue body. */
  graphComplete: true
  identityAllocations: readonly { id: string; allocationRef: ExternalRecordRef }[]
}

export type RefusedOwnUw = {
  status: 'refused'
  /** Stable diagnostic family for child selection and operator-facing refusals. */
  reason: 'incomplete' | 'unsettled' | 'changed-child'
  diagnostics: readonly UwDiagnostic[]
}

export type OwnUwObservation = FramedOwnUw | AcceptedOwnUw | RefusedOwnUw

export type ChildFacts = {
  number: number
  title: string
  state: 'OPEN' | 'CLOSED'
  /** Descriptive native close reason; never completion authority. */
  stateReason?: string | null
  labels: string[]
  body: string
  /** Fresh shared-reader authority for this exact child scope; never body-derived. */
  ownUw: OwnUwObservation
  /** Same-cut permission to establish the first mandate, not completion authority. */
  initialMandate?: InitialMandateReadiness
  /** Calculated in the same complete observation as the Epic graph. */
  completion?: 'complete' | 'not-complete' | 'indeterminate' | 'abandoned'
  completionCode?: {
    role: 'leaf' | 'parent'
    code: import('../../engine/code-range-schema.ts').CodeRange
    sources: readonly ExternalRecordRef[]
  }
  /** Canonical blocker facts from the parent-rooted UW graph. */
  blockedBy: {
    number: number
    state: 'OPEN' | 'CLOSED'
    stateReason?: string | null
    repo?: string
    dependency?: 'satisfied' | 'held'
  }[]
  stops: { run: string; reason: string }[]
  prs: PrFacts[]
  branches: BranchFacts[]
}

export type BaseCi = { state: 'red' | 'green' | 'pending' | 'none' | 'unread'; failed: string[]; pending: string[] }
export type EpicReview = {
  run: string
  verdict: 'clean' | 'blocking'
  range: string
  inputs: ActionInputs
  decision: ExternalRecordRef
}
export type HookRecord = { run: string; result: 'started' | 'ok' | 'skipped' | 'failed'; sha: string }

export type Facts = {
  epic: number
  run: string
  base: string
  /** `refs/remotes/origin/<base>` after the fetch. */
  baseSha: string
  parentIntegration: ParentIntegrationRead
  parentCompletion: UwCompletion | null
  tree: { clean: boolean; branch: string | null }
  baseCi: BaseCi
  /** Why `.dev/stack.yml` `landing` cannot be read, or `null`. A shared-state stop. */
  landingError: string | null
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
  | { action: 'parent'; ticket: number }
  | { action: 'resume'; ticket: number; branch: string; pr: PrFacts | null }
  | { action: 'stop'; ticket: number; stop: TicketStop }
  | { action: 'integrate' }
  | { action: 'final-review'; stage: 'review'; range: string }
  | { action: 'post-merge' }
  | { action: 'complete' }
  | { action: 'drop'; stop: SharedStop | 'no-progress' }
)

export type EpicStepName = 'start' | 'resume' | 'stop' | 'final-review' | 'post-merge' | 'complete' | 'drop'

export function epicStepName(step: Step): EpicStepName | null {
  if (step.action === 'integrate') return null
  if (step.action === 'parent') return 'start'
  if (step.action === 'final-review') return 'final-review'
  return step.action
}
