import type { DecodedHistory } from './history-schema.ts'
import { sameRef } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { CanonicalRecord } from './record-schema.ts'
import { type ControlRecord, controlsOf, type MandateRecord, mandateScope } from './workflow-control.ts'

/** Identifies the old continuation controls without granting them live authority. */
export function isHistoricalContinuationControl(record: CanonicalRecord | null): boolean {
  if (record?.kind !== 'operator-control') return false
  const { control } = record.payload
  return (
    control === 'pause-requested' ||
    control === 'pause-confirmed' ||
    control === 'resume' ||
    control === 'resolve-interruption'
  )
}

function pauseRequestFor(mandate: MandateRecord, record: ControlRecord): boolean {
  return (
    record.payload.control === 'pause-requested' &&
    sameRef(record.payload.mandate, { scope: mandateScope(mandate), recordId: mandate.recordId, kind: 'mandate' })
  )
}

function pauseConfirmationFor(
  history: DecodedHistory,
  mandate: MandateRecord,
  request: ControlRecord,
): ControlRecord | null {
  if (request.payload.control !== 'pause-requested') return null
  const controlId = request.payload.controlId
  const requestRef: ExternalRecordRef = {
    scope: { repository: request.repository, target: request.target },
    recordId: request.recordId,
    kind: 'operator-control',
  }
  return (
    controlsOf(history).find(
      (record) =>
        record.payload.control === 'pause-confirmed' &&
        record.payload.controlId === controlId &&
        sameRef(record.payload.mandate, {
          scope: mandateScope(mandate),
          recordId: mandate.recordId,
          kind: 'mandate',
        }) &&
        record.payload.predecessor !== null &&
        sameRef(record.payload.predecessor, requestRef) &&
        record.payload.disarm.observed === true,
    ) ?? null
  )
}

/** Historical classification only: this pause does not constrain current authority. */
export function unliftedPause(history: DecodedHistory, mandate: MandateRecord): ControlRecord | null {
  for (const request of controlsOf(history)) {
    if (!pauseRequestFor(mandate, request)) continue
    const confirmation = pauseConfirmationFor(history, mandate, request)
    if (confirmation !== null && !pauseLifted(history, confirmation)) return confirmation
  }
  return null
}

function pauseLifted(history: DecodedHistory, confirmation: ControlRecord): boolean {
  if (confirmation.payload.control !== 'pause-confirmed') return false
  const { controlId, mandate } = confirmation.payload
  return controlsOf(history).some(
    (record) =>
      record.payload.control === 'resume' &&
      record.payload.controlId === controlId &&
      sameRef(record.payload.mandate, mandate) &&
      sameRef(record.payload.predecessor, {
        scope: { repository: confirmation.repository, target: confirmation.target },
        recordId: confirmation.recordId,
        kind: 'operator-control',
      }),
  )
}
