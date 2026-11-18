import type { DecisionRef, FixRequestRef } from './fix-recovery-schema.ts'
import type { DecodedHistory, OperationRead } from './history-schema.ts'
import { equalScope } from './record-diagnostics.ts'

const evidenceKinds = ['correction-result', 'falsification-result', 'fix-result']

function reviewAttemptSpent(operation: OperationRead, decision: DecisionRef): boolean {
  if (operation.kind !== 'review-attempt' && !operation.claimedKinds.includes('review-attempt')) return false
  if (operation.status !== 'complete' || operation.record === null || operation.record.kind !== 'review-attempt')
    return true
  return (
    operation.record.inputs.includes(decision.recordId) &&
    operation.record.payload.slots.some((slot) => slot.correction !== null && slot.correction !== undefined)
  )
}

function falsificationSpent(history: DecodedHistory, correctionResultId: string, decision: DecisionRef): boolean {
  const linked = history.operations.filter(
    (candidate) =>
      candidate.authority !== 'foreign' &&
      candidate.status === 'complete' &&
      candidate.record?.kind === 'correction-result' &&
      candidate.record.recordId === correctionResultId,
  )
  const correction = linked[0]?.record
  return (
    linked.length !== 1 ||
    correction?.kind !== 'correction-result' ||
    correction.payload.decisionId === decision.recordId
  )
}

function operationSpent(
  history: DecodedHistory,
  operation: OperationRead,
  request: FixRequestRef,
  decision: DecisionRef,
): boolean {
  if (operation.authority === 'foreign') return false
  if (reviewAttemptSpent(operation, decision)) return true
  if (!evidenceKinds.some((kind) => operation.kind === kind || operation.claimedKinds.includes(kind))) return false
  if (operation.status !== 'complete' || operation.record === null) return true
  const record = operation.record
  if (record.kind === 'correction-result') return record.payload.decisionId === decision.recordId
  if (record.kind === 'fix-result')
    return record.payload.decisionId === decision.recordId || record.payload.requestId === request.recordId
  if (record.kind === 'falsification-result')
    return falsificationSpent(history, record.payload.correctionResultId, decision)
  return !evidenceKinds.includes(record.kind)
}

/** Negative evidence only: absence does not establish an authenticated unspent owner chain. */
export function hasSpentOrAmbiguousCorrectionEvidence(
  histories: readonly DecodedHistory[],
  request: FixRequestRef,
  decision: DecisionRef,
): boolean {
  return histories.some(
    (history) =>
      equalScope(history.source.scope, decision.scope) &&
      history.operations.some((operation) => operationSpent(history, operation, request, decision)),
  )
}
