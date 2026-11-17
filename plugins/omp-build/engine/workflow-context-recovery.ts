import { canonicalValueDigest, validateActionInputs } from './action-input.ts'
import { sameRef } from './record-diagnostics.ts'
import { hasNewLineageContext } from './workflow-context-lineage.ts'
import { workflowContextNegative } from './workflow-context-output.ts'
import { workflowContextResolution, workflowContextTerminal } from './workflow-context-terminal.ts'
import { excludedReceipt, type MandateRecord, mandateScope, type ReceiptRecord, recordsOf } from './workflow-control.ts'
import type { WorkflowEvidence } from './workflow-plan.ts'
import type { WorkflowFacts } from './workflow-reconstruction-types.ts'

/** Admission for the one selected, still-negative leaf; it never changes the historical result. */
export function selectedContextRecovery(
  evidence: WorkflowEvidence,
  mandate: MandateRecord,
  action: string,
  excluded: ReadonlySet<string>,
  recovery: NonNullable<WorkflowFacts['contextRecovery']>,
): ReceiptRecord | null {
  const history = evidence.causal.histories.find(
    (item) =>
      item.source.scope.repository === recovery.negative.scope.repository &&
      item.source.scope.target === recovery.negative.scope.target,
  )
  if (history === undefined || recovery.negative.kind !== 'action-receipt') return null
  const receipts = recordsOf(history).filter(
    (record): record is ReceiptRecord =>
      record.kind === 'action-receipt' && record.payload.action === action && !excludedReceipt(record, excluded),
  )
  const matches = receipts.filter((record) => record.recordId === recovery.negative.recordId)
  const negative = matches[0]
  if (
    matches.length !== 1 ||
    negative === undefined ||
    negative.payload.phase !== 'result' ||
    !workflowContextNegative(negative) ||
    !validateActionInputs(recovery.inputs).ok ||
    recovery.actionId.length === 0 ||
    recovery.actionId === negative.payload.actionId ||
    recordsOf(history).some(
      (record) => record.kind === 'action-receipt' && record.payload.actionId === recovery.actionId,
    )
  )
    return null
  const mandateRef = { scope: mandateScope(mandate), kind: 'mandate' as const, recordId: mandate.recordId }
  let previous = negative.payload.inputs
  if (negative.payload.action === 'plan-review') {
    const body = negative.payload
    const matching = body.contributions.filter(
      (item) =>
        item.host.origin === 'native' &&
        item.native?.completion === 'completed' &&
        item.native.strict === 'valid' &&
        item.host.action !== undefined &&
        item.host.slotId !== null &&
        canonicalValueDigest(item.structured) === canonicalValueDigest(body.structured) &&
        body.slots.some(
          (slot) =>
            slot.slotId === item.host.slotId &&
            slot.specialist === item.host.role &&
            slot.action !== undefined &&
            canonicalValueDigest(slot.action) === canonicalValueDigest(item.host.action),
        ),
    )
    const binding = matching[0]?.host.action
    if (
      matching.length !== 1 ||
      binding === undefined ||
      !validateActionInputs(binding.inputs).ok ||
      body.slots.some((slot) => slot.action?.actionId === recovery.actionId)
    )
      return null
    previous = binding.inputs
  }
  if (
    negative.payload.mandate.kind !== 'mandate' ||
    !sameRef(negative.payload.mandate, mandateRef) ||
    recovery.inputs.manifest.purpose !== action ||
    previous.fingerprint === recovery.inputs.fingerprint ||
    !hasNewLineageContext(history, negative, previous, recovery.inputs) ||
    workflowContextResolution(history, negative, excluded) !== 'missing'
  )
    return null
  if (!clearContextTerminals(evidence, negative, excluded)) return null
  return negative
}

function clearContextTerminals(
  evidence: WorkflowEvidence,
  negative: ReceiptRecord,
  excluded: ReadonlySet<string>,
): boolean {
  for (const current of evidence.causal.histories) {
    for (const stage of ['frame', 'plan', 'plan-review', 'assess-spec', 'attribute-ci', 'implement', 'integrate']) {
      if (workflowContextTerminal(current, stage, negative, excluded) !== 'clear') return false
    }
  }
  return true
}
