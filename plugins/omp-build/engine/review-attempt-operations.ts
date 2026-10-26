import type { DecodedHistory } from './history-schema.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { ReviewSummary } from './result.ts'
import { reviewOperations } from './review-identity.ts'

function reviewAttemptReferences(record: CanonicalRecord): string[] {
  const references = [...record.inputs]
  if (record.kind === 'review') references.push(...record.payload.inventoryIds, record.payload.decisionId)
  if (record.kind === 'decision')
    references.push(record.payload.originalContributionId, ...record.payload.judgment.sourceContributionIds)
  if (record.kind === 'contribution' && record.payload.inventoryId !== null) references.push(record.payload.inventoryId)
  return references
}

function collectReviewOperations(
  history: DecodedHistory,
  selected: DecodedHistory['operations'][number],
  reviewId: string,
  recordId: string,
  operations: Map<string, DecodedHistory['operations'][number]>,
  visiting: Set<string>,
): boolean {
  if (operations.has(recordId)) return true
  if (visiting.has(recordId)) return false
  visiting.add(recordId)
  const operation =
    recordId === reviewId ? selected : history.operations.find((candidate) => candidate.record?.recordId === recordId)
  if (operation?.record === null || operation === undefined) return false
  operations.set(recordId, operation)
  for (const reference of reviewAttemptReferences(operation.record))
    if (!collectReviewOperations(history, selected, reviewId, reference, operations, visiting)) return false
  visiting.delete(recordId)
  return true
}

/** Native operations for every record whose contents establish the selected review's verdict and findings. */
export function selectedReviewOperations(
  history: DecodedHistory,
  summary: ReviewSummary,
): DecodedHistory['operations'] | null {
  if (summary.reviewId === null) return []
  const selected = reviewOperations(history).find((operation) => operation.record?.recordId === summary.reviewId)
  const review = selected?.record
  if (review?.kind !== 'review' || selected === undefined) return null
  const operations = new Map<string, DecodedHistory['operations'][number]>()
  return collectReviewOperations(history, selected, review.recordId, review.recordId, operations, new Set())
    ? [...operations.values()]
    : null
}
