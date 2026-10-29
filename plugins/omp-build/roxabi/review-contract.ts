import type { CanonicalRecord, Json, Policy } from '../dist/contracts.js'
import type { NativeBatch, NativeBatchResult, NativeChildResult } from '../omp/review-runtime/contracts'
import type { NativeBatchController } from '../omp/review-runtime/controller'
import type { AllocateReviewInput } from '../skills/dev-review/roster-contract'
import type { ReviewConfig } from './review-assets'
import type { ObservedEvidence, PreparedReviewChunk } from './review-input-contract'
import type { ActionInputs, PreparedUwAction } from './uw-action-contract.ts'
import type { UwOperations } from './uw-contract.ts'

export type ReviewSubject = { kind: 'pull-request' } | { kind: 'epic-range'; range: string }
export type ReviewStage = 'initial' | 'recall' | 'synthesis'

export type ReviewContext = {
  operationId: string
  runId: string
  repository: string
  target: string
  candidateGitSHA: string
  input: string | null
  subject: ReviewSubject
}

export type PreparedReviewInputs = {
  context: ReviewContext & {
    number: number
    subject: { kind: 'pull-request' } | { kind: 'epic-range'; range: string }
  }
  pr: { base: string; baseGitSHA: string }
  chunks: readonly PreparedReviewChunk[]
  contextWindow: number
  roster: AllocateReviewInput['shared']
  config: ReviewConfig
  policy: Policy
  semantic: { spec: string; panel: string; synthesis: string }
  observedEvidence: ObservedEvidence
  inputSnapshot: ActionInputs
  canonicalClasses: readonly string[]
  initialInventory?: Extract<CanonicalRecord, { kind: 'review-attempt' }>
  actions: Readonly<Record<string, PreparedUwAction>>
  operations: UwOperations
  authorize(stage: ReviewStage): Promise<{ ok: true } | { ok: false; reason: string }>
}

export type PreparedReviewBatch = {
  stage: ReviewStage
  rootAttemptId: string
  inventory: Json
  batch: NativeBatch
}

export type PublishedContribution = { id: string; child: NativeChildResult }

/**
 * Host authority is binding-first: it authorizes the current stage, confirms its
 * inventory, durably retains each raw native child, then permits continuation.
 */
export type ReviewPublisher = {
  authorize(context: ReviewContext, stage: ReviewStage): Promise<{ ok: true } | { ok: false; reason: string }>
  publishInventory(
    prepared: PreparedReviewBatch,
    canContinue?: () => boolean,
  ): Promise<{ ok: true } | { ok: false; reason: string }>
  publishRawContribution(prepared: PreparedReviewBatch, child: NativeChildResult): Promise<PublishedContribution>
  completeStage(
    prepared: PreparedReviewBatch,
    result: NativeBatchResult,
    contributions: readonly PublishedContribution[],
    canContinue?: () => boolean,
  ): Promise<PreparedReviewBatch | null>
  publishRequiredStop(
    context: ReviewContext,
    stop: Json,
    options?: { writeAuthor?: string },
  ): Promise<{ ok: true } | { ok: false; reason: string }>
  stop(context: ReviewContext, reason: string, result: NativeBatchResult | null): Promise<void>
}

export type ReviewNativePort = Pick<NativeBatchController, 'activate' | 'inactive'> & {
  announce(batch: NativeBatch): Promise<void>
}
