import { classifyHistory } from './history-classification.ts'
import { validateRecordGraph } from './history-graph.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope, fail } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Diagnostic } from './record-values.ts'
import { type Result, type ReviewFacts, type ReviewState, type ReviewSummary, recordMap } from './result.ts'
import { validateDecision } from './review-decision.ts'
import { spentBeforeCurrentPullRequestAttempt, spentInCompleteHistory } from './review-history.ts'
import { analyzeReviewIdentity, reviewOperations } from './review-identity.ts'
import { readReviewRecovery } from './review-recovery.ts'
import { nextReviewState, requiredReviewStop } from './review-state-transition.ts'

export function summarizeReviews(
  history: DecodedHistory,
  taxonomy: readonly string[],
  acceptedPolicyRef: string | null,
  externalHistories: readonly DecodedHistory[] = [],
): Result<ReviewSummary> {
  return summarizeAuthorityReviews(
    classifyHistory(history).authorityHistory,
    taxonomy,
    acceptedPolicyRef,
    externalHistories,
    history,
  )
}

export { selectedReviewOperations } from './review-attempt-operations.ts'

function summaryFailure(
  diagnostics: Diagnostic[],
  knownReviews: number,
  countExact: boolean,
  spent: boolean | null,
): Result<ReviewSummary> {
  return fail(diagnostics, { knownReviews, countExact, spent })
}

function reviewTransportDiagnostics(transportDiagnostics: Diagnostic[], incompleteFinal: boolean): Diagnostic[] | null {
  if (transportDiagnostics.length > 0) return transportDiagnostics
  return incompleteFinal ? [diagnostic('incomplete', 'A final review operation is not complete')] : null
}

function latestReviewSummary(
  latest: Extract<CanonicalRecord, { kind: 'review' }> | null,
  at: ReviewSummary['at'],
  records: ReadonlyMap<string, CanonicalRecord>,
  history: DecodedHistory,
  taxonomy: readonly string[],
  acceptedPolicyRef: string | null,
  knownReviews: number,
  spent: boolean,
  externalHistories: readonly DecodedHistory[],
  deliveryHistory: DecodedHistory,
): Result<ReviewSummary> {
  if (latest === null)
    return {
      ok: true,
      value: { reviews: 0, reviewId: null, verdict: null, head: null, input: null, at: null, spent: false },
    }
  const decision = records.get(latest.payload.decisionId)
  if (decision?.kind !== 'decision')
    return summaryFailure(
      [diagnostic('unknown-reference', `Review ${latest.recordId} lacks its decision`)],
      knownReviews,
      true,
      spent,
    )
  const assessment = validateDecision(
    decision,
    history,
    taxonomy,
    acceptedPolicyRef,
    externalHistories,
    deliveryHistory,
  )
  if (assessment.verdict === null) return summaryFailure(assessment.diagnostics, knownReviews, true, spent)
  return {
    ok: true,
    value: {
      reviews: knownReviews,
      reviewId: latest.recordId,
      verdict: assessment.verdict,
      head: latest.payload.candidateGitSHA,
      input: latest.payload.input,
      at,
      spent,
    },
  }
}

function validateAuthorityReviewSpend(
  reviews: DecodedHistory['operations'],
  records: ReadonlyMap<string, CanonicalRecord>,
  history: DecodedHistory,
  taxonomy: readonly string[],
  acceptedPolicyRef: string | null,
  initialSpent: boolean,
  externalHistories: readonly DecodedHistory[],
  deliveryHistory: DecodedHistory,
) {
  let spent = initialSpent
  for (const [index, review] of reviews.entries()) {
    const record = review.record
    if (record?.kind !== 'review') continue
    const decision = records.get(record.payload.decisionId)
    if (decision?.kind !== 'decision')
      return {
        diagnostics: [diagnostic('unknown-reference', `Review ${record.recordId} lacks its decision`)],
        spent,
      }
    const assessment = validateDecision(
      decision,
      history,
      taxonomy,
      acceptedPolicyRef,
      externalHistories,
      deliveryHistory,
    )
    if (!assessment.admissible) return { diagnostics: assessment.diagnostics, spent }
    if (index >= 2 && assessment.verdict === 'Request changes') spent = true
  }
  return { diagnostics: null, spent }
}

function summarizeAuthorityReviews(
  history: DecodedHistory,
  taxonomy: readonly string[],
  acceptedPolicyRef: string | null,
  externalHistories: readonly DecodedHistory[],
  deliveryHistory: DecodedHistory,
): Result<ReviewSummary> {
  const identity = analyzeReviewIdentity(history, recordMap(history))
  const reviews = identity.reviews
  const knownReviews = identity.knownReviews
  const preservedSpent =
    spentInCompleteHistory(history, taxonomy, acceptedPolicyRef, externalHistories, deliveryHistory) ??
    spentBeforeCurrentPullRequestAttempt(history, taxonomy, acceptedPolicyRef, externalHistories, deliveryHistory)
  const uncertainSpent: boolean | null = preservedSpent === true ? true : reviews.length >= 3 ? null : false
  const transportDiagnostics = reviewTransportDiagnostics(identity.transportDiagnostics, identity.incompleteFinal)
  if (transportDiagnostics !== null)
    return summaryFailure(transportDiagnostics, knownReviews, history.source.complete, uncertainSpent)
  const recovery = readReviewRecovery(history)
  if (!recovery.ok) return summaryFailure(recovery.diagnostics, knownReviews, history.source.complete, uncertainSpent)
  if (recovery.value.normalProgression === 'stopped')
    return summaryFailure(
      [diagnostic('incomplete', 'An interrupted review root remains stopped pending its replacement outcome')],
      knownReviews,
      true,
      uncertainSpent,
    )
  const graph = validateRecordGraph(history)
  if (!graph.ok) return summaryFailure(graph.diagnostics, knownReviews, history.source.complete, uncertainSpent)
  const records = new Map(graph.value.map((record) => [record.recordId, record]))
  const reviewSpend = validateAuthorityReviewSpend(
    reviews,
    records,
    history,
    taxonomy,
    acceptedPolicyRef,
    preservedSpent === true,
    externalHistories,
    deliveryHistory,
  )
  if (reviewSpend.diagnostics !== null)
    return summaryFailure(reviewSpend.diagnostics, knownReviews, true, reviewSpend.spent)
  if (identity.lineageDiagnostics.length > 0)
    return summaryFailure(identity.lineageDiagnostics, knownReviews, true, reviewSpend.spent)
  if (identity.pendingRoot !== null)
    return summaryFailure(
      [
        diagnostic(
          'incomplete',
          `Pull-request review inventory ${identity.pendingRoot.recordId} is pending completion by its own final review`,
          { rootId: identity.pendingRoot.recordId, pendingRoot: true },
        ),
      ],
      knownReviews,
      true,
      reviewSpend.spent,
    )
  const at = identity.latestOperation?.parts.map((part) => part.createdAt).find((value) => value !== null) ?? null
  return latestReviewSummary(
    identity.latest,
    at,
    records,
    history,
    taxonomy,
    acceptedPolicyRef,
    knownReviews,
    reviewSpend.spent,
    externalHistories,
    deliveryHistory,
  )
}

function spentReviewFor(
  reviews: readonly Extract<CanonicalRecord, { kind: 'review' }>[],
  records: ReadonlyMap<string, CanonicalRecord>,
  history: DecodedHistory,
  taxonomy: readonly string[],
  acceptedPolicyRef: string | null,
  externalHistories: readonly DecodedHistory[],
  deliveryHistory: DecodedHistory,
): Result<Extract<CanonicalRecord, { kind: 'review' }> | null> {
  let spentReview: Extract<CanonicalRecord, { kind: 'review' }> | null = null
  for (const [index, review] of reviews.entries()) {
    const decision = records.get(review.payload.decisionId)
    if (decision?.kind !== 'decision')
      return fail([diagnostic('unknown-reference', `Review ${review.recordId} lacks its decision`)])
    const assessment = validateDecision(
      decision,
      history,
      taxonomy,
      acceptedPolicyRef,
      externalHistories,
      deliveryHistory,
    )
    if (!assessment.admissible) return fail(assessment.diagnostics)
    if (index >= 2 && assessment.verdict === 'Request changes' && spentReview === null) spentReview = review
  }
  return { ok: true, value: spentReview }
}
function reviewStateFailure(
  diagnostics: Diagnostic[],
  knownReviews: number,
  countExact: boolean,
  spent: boolean | null,
): ReviewState {
  return { ok: false, next: 'stop', knownReviews, countExact, spent, diagnostics }
}

export function deriveReviewState(
  history: DecodedHistory,
  facts: ReviewFacts,
  taxonomy: readonly string[],
  externalHistories: readonly DecodedHistory[] = [],
): ReviewState {
  if (!equalScope(history.source.scope, facts))
    return reviewStateFailure([diagnostic('unbound', 'Fresh facts have another review scope')], 0, false, null)
  const authorityHistory = classifyHistory(history).authorityHistory
  const summary = summarizeAuthorityReviews(
    authorityHistory,
    taxonomy,
    facts.acceptedEvidencePolicyRef,
    externalHistories,
    history,
  )
  if (!summary.ok)
    return reviewStateFailure(
      summary.diagnostics,
      summary.knownReviews ?? 0,
      summary.countExact ?? false,
      summary.spent ?? null,
    )
  const orderedReviews = reviewOperations(authorityHistory).flatMap((operation) =>
    operation.record?.kind === 'review' ? [operation.record] : [],
  )
  const records = recordMap(authorityHistory)
  const persistedStop = [...records.values()].find(
    (record): record is Extract<CanonicalRecord, { kind: 'stop' }> => record.kind === 'stop',
  )
  if (persistedStop !== undefined)
    return { ok: true, summary: { ...summary.value, spent: true }, next: 'stop', requiredStop: persistedStop.payload }
  const reviewSpend = spentReviewFor(
    orderedReviews,
    records,
    authorityHistory,
    taxonomy,
    facts.acceptedEvidencePolicyRef,
    externalHistories,
    history,
  )
  if (!reviewSpend.ok) return reviewStateFailure(reviewSpend.diagnostics, summary.value.reviews, true, null)
  const latestReview = orderedReviews.length === 0 ? undefined : orderedReviews[orderedReviews.length - 1]
  const requiredStop = requiredReviewStop(reviewSpend.value, latestReview, orderedReviews.length, summary.value, facts)
  if (requiredStop !== null) return { ok: true, summary: { ...summary.value, spent: true }, next: 'stop', requiredStop }
  if (facts.ci === 'unknown')
    return reviewStateFailure(
      [diagnostic('unreadable', 'CI state is unknown and cannot retain an arm')],
      summary.value.reviews,
      true,
      summary.value.spent,
    )
  return nextReviewState(summary.value, facts)
}
