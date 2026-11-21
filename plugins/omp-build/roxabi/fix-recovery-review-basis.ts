import {
  type CanonicalRecord,
  canonicalValueDigest,
  type DecodedHistory,
  type GitHubOptions,
  sameOwnSpecRef,
} from '../dist/contracts.js'
import type {
  FixActionResult,
  FixRecord,
  FixRequestInput,
  FixTarget,
  PreparedFix,
  TargetResolver,
} from './fix-contract.ts'
import { failure } from './fix-contract.ts'
import type { DefaultFixEntry } from './fix-entry-input.ts'
import { confirmedRecord, loadBoundReview, validateReviewOrigin } from './fix-entry-review-bound.ts'
import { prepareReviewBoundBasis } from './fix-preparation-review.ts'

/**
 * Reconstructs a review-bound continuation from the original confirmed R/D without
 * invoking the fresh source/request producer. Core must separately authenticate the
 * owner's unspent lineage and the selected history cut before this basis is used.
 */
export async function prepareRecoveryReviewBasis(input: {
  entry: DefaultFixEntry
  requestInput: FixRequestInput
  target: FixTarget
  resolver: TargetResolver
  originalRequest: Extract<FixRecord, { kind: 'fix-request' }>
  originalDecision: Extract<FixRecord, { kind: 'decision' }>
  readHistory: () => Promise<DecodedHistory>
  github: GitHubOptions
  signal: AbortSignal
}): Promise<
  FixActionResult<{
    prepared: PreparedFix
    decision: Extract<FixRecord, { kind: 'decision' }>
    review: Extract<CanonicalRecord, { kind: 'review' }>
  }>
> {
  const request = input.originalRequest
  const reviewId = request.payload.existingReviewId
  if (
    reviewId === null ||
    input.requestInput.scope !== request.payload.scope ||
    request.repository !== input.target.repository ||
    request.target !== input.target.target
  )
    return failure('recovery-original-request-mismatch')
  const review = await loadBoundReview(input.entry, input.target, input.readHistory, reviewId, input.github)
  if (!review.ok) return review
  const persisted = confirmedRecord(review.value.history, request.recordId, 'fix-request')
  const source = confirmedRecord(review.value.history, request.payload.requestContributionId, 'contribution')
  if (
    persisted?.kind !== 'fix-request' ||
    source?.kind !== 'contribution' ||
    canonicalValueDigest(persisted) !== canonicalValueDigest(request) ||
    canonicalValueDigest(review.value.decision) !== canonicalValueDigest(input.originalDecision)
  )
    return failure('recovery-original-records-unconfirmed')
  const basis = await prepareReviewBoundBasis(
    {
      ...input.requestInput,
      reviewId,
      candidateGitSHA: review.value.candidate,
      policy: review.value.decision.payload.judgment.policy,
      nativeTasks: [],
    },
    input.resolver,
    input.entry.workflow,
    input.signal,
  )
  if (!basis.ok) return basis
  const origin = validateReviewOrigin(review.value.history, review.value.reviewRecord, basis.value.causeContext)
  if (!origin.ok) return origin
  if (!sameOwnSpecRef(request.payload.originalSpec, basis.value.causeContext.effective.own))
    return failure('correction-origin-stale')
  return {
    ok: true,
    value: {
      prepared: {
        target: basis.value.target,
        causeContext: basis.value.causeContext,
        subject: basis.value.subject,
        requestId: request.recordId,
        sourceContributionId: source.recordId,
        inventoryId: reviewId,
        policy: review.value.decision.payload.judgment.policy,
        cwd: input.requestInput.cwd,
        publishBinding: input.requestInput.publishBinding,
        batch: {
          operationId: input.requestInput.identity.operationId,
          tasks: { context: 'review-bound correction has no intake batch', tasks: [] },
        },
      },
      decision: review.value.decision,
      review: review.value.reviewRecord,
    },
  }
}
