import type { Json } from '../dist/contracts.js'
import type { NativeBatch, NativeBatchResult, NativeChildResult } from '../omp/review-runtime/contracts'
import type { NativeBatchController } from '../omp/review-runtime/controller'

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
  publishInventory(prepared: PreparedReviewBatch): Promise<{ ok: true } | { ok: false; reason: string }>
  publishRawContribution(prepared: PreparedReviewBatch, child: NativeChildResult): Promise<PublishedContribution>
  completeStage(
    prepared: PreparedReviewBatch,
    result: NativeBatchResult,
    contributions: readonly PublishedContribution[],
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
