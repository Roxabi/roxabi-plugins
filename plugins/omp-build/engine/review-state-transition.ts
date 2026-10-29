import type { CanonicalRecord } from './record-schema.ts'
import type { ReviewFacts, ReviewState, ReviewSummary } from './result.ts'
import type { Stop } from './review-schema.ts'

function latestApprovingReview(
  latestReview: Extract<CanonicalRecord, { kind: 'review' }> | undefined,
  summary: ReviewSummary,
): Extract<CanonicalRecord, { kind: 'review' }> | null {
  return latestReview !== undefined && summary.verdict !== null && summary.verdict !== 'Request changes'
    ? latestReview
    : null
}

function redCiRequiresStop(
  review: Extract<CanonicalRecord, { kind: 'review' }> | null,
  reviewCount: number,
  facts: ReviewFacts,
): boolean {
  return (
    reviewCount > 2 && review !== null && review.payload.candidateGitSHA === facts.candidateGitSHA && facts.ci === 'red'
  )
}

export function requiredReviewStop(
  spentReview: Extract<CanonicalRecord, { kind: 'review' }> | null,
  latestReview: Extract<CanonicalRecord, { kind: 'review' }> | undefined,
  reviewCount: number,
  summary: ReviewSummary,
  facts: ReviewFacts,
): Stop | null {
  if (spentReview !== null) {
    return {
      reason: 'review-bound',
      reviewId: spentReview.recordId,
      detail: { reviews: summary.reviews, verdict: 'Request changes' },
    }
  }
  const approved = latestApprovingReview(latestReview, summary)
  if (!redCiRequiresStop(approved, reviewCount, facts)) return null
  if (approved === null) return null
  return {
    reason: 'ci-failed',
    reviewId: approved.recordId,
    detail: { reviews: summary.reviews, ci: facts.ci },
  }
}

export function nextReviewState(summary: ReviewSummary, facts: ReviewFacts): ReviewState {
  if (summary.head !== null && summary.head !== facts.candidateGitSHA) {
    return { ok: true, summary, next: 'review', requiredStop: null }
  }
  if (summary.input !== facts.input) return { ok: true, summary, next: 'review', requiredStop: null }
  if (facts.ci === 'pending' || facts.ci === 'red') return { ok: true, summary, next: 'wait', requiredStop: null }
  if (summary.verdict === 'Request changes') return { ok: true, summary, next: 'fix', requiredStop: null }
  return { ok: true, summary, next: summary.verdict === null ? 'review' : 'admit', requiredStop: null }
}
