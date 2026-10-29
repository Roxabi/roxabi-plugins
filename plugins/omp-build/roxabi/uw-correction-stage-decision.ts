import { canonicalValueDigest } from '../engine/action-input.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import { validateDecisionBindings } from '../engine/review-decision.ts'
import { historyFor, recordsOf, workflowOperationProblem } from '../engine/workflow-control.ts'
import type { RecordInputRef, UwActionRequest } from './uw-action-contract.ts'
import { authenticate } from './uw-action-observe.ts'

function hasAuthenticatedLineage(
  decision: Extract<CanonicalRecord, { kind: 'decision' }>,
  records: readonly CanonicalRecord[],
  histories: readonly DecodedHistory[],
): boolean {
  const originals = records.filter(
    (record): record is Extract<CanonicalRecord, { kind: 'contribution' }> =>
      record.kind === 'contribution' && record.recordId === decision.payload.originalContributionId,
  )
  const original = originals[0]
  if (
    originals.length !== 1 ||
    original === undefined ||
    original.payload.inventoryId === null ||
    !authenticate(original, histories).ok
  )
    return false
  const inventories = records.filter(
    (record): record is Extract<CanonicalRecord, { kind: 'review-attempt' }> =>
      record.kind === 'review-attempt' && record.recordId === original.payload.inventoryId,
  )
  const inventory = inventories[0]
  return inventories.length === 1 && inventory !== undefined && authenticate(inventory, histories).ok
}

/** A prior decision is stage data, not selection authority for dispatch. */
export function priorCorrectionDecision(
  ref: RecordInputRef,
  request: UwActionRequest,
  histories: readonly DecodedHistory[],
): boolean {
  if (request.purpose !== 'correction' || ref.record.kind !== 'decision' || ref.selector !== '/payload') return false
  const scope = request.subject.pullRequest
  if (
    scope === null ||
    scope.repository !== ref.record.scope.repository ||
    scope.target !== ref.record.scope.target ||
    request.code.repository !== scope.repository
  )
    return false
  const history = historyFor(scope, histories)
  if (history === null || workflowOperationProblem(history) !== null) return false
  const records = recordsOf(history)
  const decisions = records.filter(
    (record): record is Extract<CanonicalRecord, { kind: 'decision' }> =>
      record.kind === 'decision' && record.recordId === ref.record.recordId,
  )
  const decision = decisions[0]
  if (
    decisions.length !== 1 ||
    decision === undefined ||
    canonicalValueDigest(decision.payload) !== ref.digest ||
    !authenticate(decision, histories).ok ||
    !validateDecisionBindings(decision, history).admissible
  )
    return false
  return hasAuthenticatedLineage(decision, records, histories)
}
