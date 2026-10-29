import { validateRecordGraph } from './history-graph.ts'
import type { DecodedHistory } from './history-schema.ts'
import { recordMap } from './result.ts'
import { reviewContextLineage } from './review-context-lineage.ts'
import { validateDecision } from './review-decision.ts'
import { latestUnfinishedPullRequestRoot, reviewOperations } from './review-identity.ts'

export function spentBeforeCurrentPullRequestAttempt(
  history: DecodedHistory,
  taxonomy: readonly string[],
  acceptedPolicyRef: string | null,
  externalHistories: readonly DecodedHistory[] = [],
  deliveryHistory: DecodedHistory = history,
): boolean | null {
  const records = recordMap(history)
  const root = latestUnfinishedPullRequestRoot(records, reviewContextLineage(history, records).superseded)
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
  const deliveryRootIndex = deliveryHistory.operations.findIndex(
    (operation) => operation.status === 'complete' && operation.record?.recordId === root.recordId,
  )
  if (deliveryRootIndex === -1) return null
  const deliveryPrefix: DecodedHistory = {
    ...deliveryHistory,
    operations: deliveryHistory.operations.slice(0, deliveryRootIndex),
  }
  return spentInCompleteHistory(prefix, taxonomy, acceptedPolicyRef, externalHistories, deliveryPrefix)
}
export function spentInCompleteHistory(
  history: DecodedHistory,
  taxonomy: readonly string[],
  acceptedPolicyRef: string | null,
  externalHistories: readonly DecodedHistory[] = [],
  deliveryHistory: DecodedHistory = history,
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
    const assessment = validateDecision(
      decision,
      completedHistory,
      taxonomy,
      acceptedPolicyRef,
      externalHistories,
      deliveryHistory,
    )
    if (!assessment.admissible) return null
    if (assessment.verdict === 'Request changes') return true
  }
  return false
}
