import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, fail } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Result } from './result.ts'
import type { ReviewClassCatalogues } from './review-class-catalogue.ts'
import { validateDecision } from './review-decision.ts'
import { validateHistoricalReviewDecision } from './review-fresh-decision.ts'
export function spentReviewFor(
  reviews: readonly Extract<CanonicalRecord, { kind: 'review' }>[],
  records: ReadonlyMap<string, CanonicalRecord>,
  history: DecodedHistory,
  catalogues: ReviewClassCatalogues,
  acceptedPolicyRef: string | null,
  externalHistories: readonly DecodedHistory[],
  deliveryHistory: DecodedHistory,
): Result<Extract<CanonicalRecord, { kind: 'review' }> | null> {
  let spentReview: Extract<CanonicalRecord, { kind: 'review' }> | null = null
  for (const [index, review] of reviews.entries()) {
    const decision = records.get(review.payload.decisionId)
    if (decision?.kind !== 'decision')
      return fail([diagnostic('unknown-reference', `Review ${review.recordId} lacks its decision`)])
    const assessed =
      review.payload.causeDispositionRefs === undefined
        ? {
            ok: true as const,
            value: validateDecision(
              decision,
              history,
              catalogues,
              acceptedPolicyRef,
              externalHistories,
              deliveryHistory,
            ),
          }
        : validateHistoricalReviewDecision(
            decision,
            history,
            catalogues,
            acceptedPolicyRef,
            externalHistories,
            deliveryHistory,
            review.payload.causeDispositionRefs,
          )
    if (!assessed.ok) return fail(assessed.diagnostics)
    const assessment = assessed.value
    if (!assessment.admissible) return fail(assessment.diagnostics)
    if (index >= 2 && assessment.verdict === 'Request changes' && spentReview === null) spentReview = review
  }
  return { ok: true, value: spentReview }
}
