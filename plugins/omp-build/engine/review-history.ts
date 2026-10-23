import { validateRecordGraph } from './history-graph.ts'
import type { DecodedHistory } from './history-schema.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Diagnostic } from './record-values.ts'
import { diagnostic, recordMap } from './result.ts'
import { validateDecision } from './review-decision.ts'

export function reviewOperations(history: DecodedHistory) {
  const operations: typeof history.operations = []
  const identities = new Set<string>()
  for (const operation of history.operations) {
    if (operation.kind !== 'review' && operation.record?.kind !== 'review') continue
    const identity =
      operation.operationId ?? operation.recordId ?? operation.parts.map((part) => part.locator).join('|')
    if (!identities.has(identity)) {
      identities.add(identity)
      operations.push(operation)
    }
  }
  return operations
}
function latestUnfinishedPullRequestRoot(
  records: ReadonlyMap<string, CanonicalRecord>,
): Extract<CanonicalRecord, { kind: 'review-attempt' }> | null {
  let latest: Extract<CanonicalRecord, { kind: 'review-attempt' }> | null = null
  for (const record of records.values()) {
    if (
      record.kind === 'review-attempt' &&
      record.payload.stage === 'initial' &&
      record.payload.purpose === 'review' &&
      record.payload.subject.kind === 'pull-request'
    ) {
      latest = record
      continue
    }
    if (record.kind === 'review' && latest !== null && record.payload.inventoryIds.includes(latest.recordId))
      latest = null
  }
  return latest
}
type ReviewIdentity = {
  reviews: DecodedHistory['operations']
  knownReviews: number
  latest: Extract<CanonicalRecord, { kind: 'review' }> | null
  latestOperation: DecodedHistory['operations'][number] | null
  transportDiagnostics: Diagnostic[]
  incompleteFinal: boolean
  pendingRoot: Extract<CanonicalRecord, { kind: 'review-attempt' }> | null
}
export function analyzeReviewIdentity(
  history: DecodedHistory,
  records: ReadonlyMap<string, CanonicalRecord>,
): ReviewIdentity {
  const reviews = reviewOperations(history)
  const incompleteFinal = reviews.some((review) => review.status !== 'complete' || review.record?.kind !== 'review')
  const latestOperation = incompleteFinal || reviews.length === 0 ? null : reviews[reviews.length - 1]
  const latest = latestOperation?.record?.kind === 'review' ? latestOperation.record : null
  const transportDiagnostics = [...history.diagnostics, ...history.source.diagnostics]
  if (!history.source.complete) transportDiagnostics.push(diagnostic('incomplete', 'Review history is incomplete'))
  return {
    reviews,
    knownReviews: reviews.length,
    latest,
    latestOperation,
    transportDiagnostics,
    incompleteFinal,
    pendingRoot: latestUnfinishedPullRequestRoot(records),
  }
}
export function spentBeforeCurrentPullRequestAttempt(
  history: DecodedHistory,
  taxonomy: readonly string[],
  acceptedPolicyRef: string | null,
): boolean | null {
  const root = latestUnfinishedPullRequestRoot(recordMap(history))
  if (root === null) return null
  const rootIndex = history.operations.findIndex(
    (operation) => operation.status === 'complete' && operation.record?.recordId === root.recordId,
  )
  if (rootIndex === -1) return null
  const prefix: DecodedHistory = {
    ...history,
    source: { ...history.source, complete: true, diagnostics: [] },
    operations: history.operations.slice(0, rootIndex),
    diagnostics: [],
  }
  return spentInCompleteHistory(prefix, taxonomy, acceptedPolicyRef)
}
export function spentInCompleteHistory(
  history: DecodedHistory,
  taxonomy: readonly string[],
  acceptedPolicyRef: string | null,
): boolean | null {
  const completedHistory: DecodedHistory = {
    ...history,
    source: { ...history.source, complete: true, diagnostics: [] },
    operations: history.operations.filter((operation) => operation.status === 'complete' && operation.record !== null),
    diagnostics: [],
  }
  const graph = validateRecordGraph(completedHistory)
  if (!graph.ok) return null
  const records = new Map(graph.value.map((record) => [record.recordId, record]))
  if ([...records.values()].some((record) => record.kind === 'stop')) return true
  const reviews = reviewOperations(completedHistory)
  for (const [index, operation] of reviews.entries()) {
    if (index < 2 || operation.record?.kind !== 'review') continue
    const decision = records.get(operation.record.payload.decisionId)
    if (decision?.kind !== 'decision') return null
    const assessment = validateDecision(decision, completedHistory, taxonomy, acceptedPolicyRef)
    if (!assessment.admissible) return null
    if (assessment.verdict === 'Request changes') return true
  }
  return false
}
