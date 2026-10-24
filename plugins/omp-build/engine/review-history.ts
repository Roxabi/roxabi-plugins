import { validateRecordGraph } from './history-graph.ts'
import type { DecodedHistory } from './history-schema.ts'
import { recordMap } from './result.ts'
import { validateDecision } from './review-decision.ts'
import { latestUnfinishedPullRequestRoot, reviewOperations } from './review-identity.ts'

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
