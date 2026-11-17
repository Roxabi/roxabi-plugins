import type { DecodedHistory } from './history-schema.ts'
import { sameRef } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import { type ControlRecord, controlsOf, historyFor, type MandateRecord } from './workflow-control.ts'

export type MandateRef = ExternalRecordRef & { kind: 'mandate' }

export function isMandateRef(ref: ExternalRecordRef): ref is MandateRef {
  return ref.kind === 'mandate'
}

export function matchingControls(histories: readonly DecodedHistory[], successor: MandateRef) {
  const home = historyFor(successor.scope, histories)
  if (home === null || !home.source.complete) return null
  return controlsOf(home).filter(
    (control) => control.payload.control === 'select-successor' && sameRef(control.payload.successor, successor),
  )
}

export function isStrictPredecessorCut(
  captured: readonly DecodedHistory[],
  histories: readonly DecodedHistory[],
  control: ControlRecord,
  mandate: MandateRecord,
): boolean {
  const strict =
    captured.length < histories.length ||
    captured.some((part) => {
      const source = historyFor(part.source.scope, histories)
      return source !== null && part.operations.length < source.operations.length
    })
  if (!strict) return false
  return !captured.some((part) =>
    part.operations.some(
      (operation) =>
        (operation.recordId === control.recordId &&
          operation.kind === 'operator-control' &&
          part.source.scope.repository === control.repository &&
          part.source.scope.target === control.target) ||
        (operation.recordId === mandate.recordId &&
          operation.kind === 'mandate' &&
          part.source.scope.repository === mandate.repository &&
          part.source.scope.target === mandate.target),
    ),
  )
}
