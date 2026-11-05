import { bindExternalRef, reviewInputSnapshotSchema, reviewRootFromDecision } from '../dist/contracts.js'
import type { ActionInputs } from '../engine/action-input-schema.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { Result } from '../engine/result.ts'
import type { ReviewRootRef } from './uw-action-contract.ts'
import { actionFailure } from './uw-action-result.ts'

/** Resolve the exact selected review through its authenticated decision and initial inventory. */
export function selectedReviewRoot(history: DecodedHistory, reviewId: string): Result<ReviewRootRef> {
  const scope = history.source.scope
  const review = bindExternalRef({ scope, kind: 'review', recordId: reviewId }, history)
  if (!review.ok) return review
  if (review.value.kind !== 'review') return actionFailure('review-input-changed', 'Selected record is not a review')
  const decision = bindExternalRef({ scope, kind: 'decision', recordId: review.value.payload.decisionId }, history)
  if (!decision.ok) return decision
  if (decision.value.kind !== 'decision')
    return actionFailure('review-input-changed', 'Selected review decision is absent')
  const root = reviewRootFromDecision(decision.value, history)
  if (!root.ok) return root
  if (
    root.value.payload.stage !== 'initial' ||
    root.value.payload.purpose !== 'review' ||
    root.value.payload.candidateGitSHA !== review.value.payload.candidateGitSHA ||
    root.value.payload.input !== review.value.payload.input
  )
    return actionFailure('review-input-changed', 'Selected review does not match its initial inventory')
  return { ok: true, value: { scope, kind: 'review-attempt', recordId: root.value.recordId } }
}

export function selectedReviewInputs(
  history: DecodedHistory,
  root: ReviewRootRef,
  fingerprint: string,
): Result<ActionInputs> {
  const bound = bindExternalRef(root, history)
  if (!bound.ok) return bound
  const record = bound.value
  if (
    record.kind !== 'review-attempt' ||
    record.payload.stage !== 'initial' ||
    record.payload.purpose !== 'review' ||
    record.payload.rootAttemptId !== record.recordId
  )
    return actionFailure('review-input-changed', 'Selected initial review inventory is absent')
  const parsed = reviewInputSnapshotSchema.safeParse(record.payload.inputSnapshot)
  if (!parsed.success || parsed.data.fingerprint !== fingerprint || record.payload.actionInputDigest !== fingerprint)
    return actionFailure('review-input-changed', 'Reviewed action inputs are absent')
  return { ok: true, value: parsed.data }
}
