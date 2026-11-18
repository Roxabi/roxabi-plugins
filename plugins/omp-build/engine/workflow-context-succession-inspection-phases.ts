import { canonicalValueDigest } from './canonical-value.ts'
import type { DecodedHistory } from './history-schema.ts'
import { sameRef } from './record-diagnostics.ts'
import type { Result } from './result.ts'
import { contextHandoffHistoryDigest, contextHandoffPrefixHistories } from './workflow-context-handoff-history.ts'
import {
  type ContextNegativeInspection,
  inspectContextNegativeReceipt,
} from './workflow-context-negative-inspection.ts'
import type { ContextSuccessionAdmission } from './workflow-context-succession.ts'
import {
  isMandateRef,
  isStrictPredecessorCut,
  type MandateRef,
  matchingControls,
} from './workflow-context-succession-comparisons.ts'
import { inspectionFailure } from './workflow-context-succession-inspection-data.ts'
import {
  bindExternalRef,
  type ControlRecord,
  controlsOf,
  historyFor,
  type MandateRecord,
  mandateScope,
} from './workflow-control.ts'

type SelectSuccessorPayload = Extract<ControlRecord['payload'], { control: 'select-successor' }>
export type IncomingSelection = {
  successor: MandateRef
  control: ControlRecord
  payload: SelectSuccessorPayload
  disposition: NonNullable<SelectSuccessorPayload['contextDisposition']>
}
export type TraversalEdge = { successor: MandateRef; requested: MandateRef; control: ControlRecord }
export type OutgoingSelection = TraversalEdge & { mandate: MandateRecord }

export function selectIncoming(
  histories: readonly DecodedHistory[],
  mandate: MandateRecord,
): Result<IncomingSelection | undefined> {
  const successor: MandateRef = { scope: mandateScope(mandate), kind: 'mandate', recordId: mandate.recordId }
  const home = historyFor(successor.scope, histories)
  if (home === null) return inspectionFailure()
  const bound = bindExternalRef(successor, home)
  if (!bound.ok || canonicalValueDigest(bound.value) !== canonicalValueDigest(mandate)) return inspectionFailure()
  const controls = matchingControls(histories, successor)
  if (controls === null) return inspectionFailure()
  if (controls.length === 0) return { ok: true, value: undefined }
  if (controls.length !== 1 || controls[0] === undefined) return inspectionFailure()
  const control = controls[0]
  const payload = control.payload
  if (payload.control !== 'select-successor') return inspectionFailure()
  if (payload.contextDisposition === undefined) return { ok: true, value: undefined }
  return { ok: true, value: { successor, control, payload, disposition: payload.contextDisposition } }
}

export function reconstructIncomingPrefix(
  histories: readonly DecodedHistory[],
  selection: IncomingSelection,
): Result<readonly DecodedHistory[]> {
  const { successor, control, disposition } = selection
  const home = historyFor(successor.scope, histories)
  if (home === null) return inspectionFailure()
  const bound = bindExternalRef({ scope: successor.scope, kind: 'operator-control', recordId: control.recordId }, home)
  if (!bound.ok || canonicalValueDigest(bound.value) !== canonicalValueDigest(control)) return inspectionFailure()
  const prefix = contextHandoffPrefixHistories(histories, disposition.reconciliation.cuts)
  return prefix === null ? inspectionFailure() : { ok: true, value: prefix }
}

export function validateCapturedCut(
  captured: readonly DecodedHistory[],
  histories: readonly DecodedHistory[],
  selection: IncomingSelection,
  mandate: MandateRecord,
): Result<void> {
  if (contextHandoffHistoryDigest(captured) !== selection.disposition.reconciliation.historyDigest)
    return inspectionFailure()
  if (!isStrictPredecessorCut(captured, histories, selection.control, mandate)) return inspectionFailure()
  return { ok: true, value: undefined }
}

export function qualifyCapturedNegative(
  admission: ContextSuccessionAdmission,
  expectedMandate: MandateRecord,
  captured: readonly DecodedHistory[],
  selection: IncomingSelection,
): Result<{ predecessor: MandateRef; inspection: ContextNegativeInspection }> {
  if (canonicalValueDigest(admission.successor) !== canonicalValueDigest(expectedMandate)) return inspectionFailure()
  const predecessor = selection.payload.predecessor
  const home = historyFor(predecessor.scope, captured)
  if (home === null) return inspectionFailure()
  const bound = bindExternalRef(predecessor, home)
  if (!bound.ok || bound.value.kind !== 'mandate' || !isMandateRef(predecessor)) return inspectionFailure()
  const inspected = inspectContextNegativeReceipt({
    mandate: bound.value,
    histories: captured,
    negative: selection.disposition.negative,
  })
  return inspected.ok ? { ok: true, value: { predecessor, inspection: inspected.value.inspection } } : inspected
}

export function selectOutgoing(
  histories: readonly DecodedHistory[],
  mandate: MandateRecord,
): Result<OutgoingSelection | undefined> {
  const requested: MandateRef = { scope: mandateScope(mandate), kind: 'mandate', recordId: mandate.recordId }
  const home = historyFor(requested.scope, histories)
  if (home === null) return inspectionFailure()
  const outgoing = controlsOf(home).filter(
    (control) =>
      control.payload.control === 'select-successor' &&
      control.payload.contextDisposition !== undefined &&
      sameRef(control.payload.predecessor, requested),
  )
  if (outgoing.length > 1) return inspectionFailure()
  if (outgoing.length === 0) return { ok: true, value: undefined }
  const control = outgoing[0]
  if (
    control === undefined ||
    control.payload.control !== 'select-successor' ||
    !isMandateRef(control.payload.successor)
  )
    return inspectionFailure()
  const successor = control.payload.successor
  const bound = bindExternalRef(successor, home)
  if (!bound.ok || bound.value.kind !== 'mandate') return inspectionFailure()
  return { ok: true, value: { requested, successor, control, mandate: bound.value } }
}

export function selectPriorLink(histories: readonly DecodedHistory[], successor: MandateRef): Result<TraversalEdge> {
  const controls = matchingControls(histories, successor)
  const control = controls?.[0]
  if (
    controls?.length !== 1 ||
    control?.payload.control !== 'select-successor' ||
    !isMandateRef(control.payload.predecessor)
  )
    return inspectionFailure()
  return { ok: true, value: { successor, requested: control.payload.predecessor, control } }
}

export function bindSavedPredecessor(
  histories: readonly DecodedHistory[],
  requested: MandateRef,
): Result<MandateRecord> {
  const home = historyFor(requested.scope, histories)
  if (home === null) return inspectionFailure()
  const bound = bindExternalRef(requested, home)
  if (!bound.ok || bound.value.kind !== 'mandate') return inspectionFailure()
  return { ok: true, value: bound.value }
}
