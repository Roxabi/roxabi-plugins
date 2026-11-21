import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, sameRef } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { Diagnostic } from './record-values.ts'
import {
  bindExternalRef,
  type ControlRecord,
  controlsOf,
  historyFor,
  type MandateRecord,
  mandateScope,
} from './workflow-control.ts'

export type PauseBinding = {
  mandate: ExternalRecordRef
  confirmation: ExternalRecordRef
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

export function confirmedPause(history: DecodedHistory, mandate: MandateRecord): ControlRecord | null {
  for (const request of controlsOf(history)) {
    if (!pauseRequestFor(mandate, request)) continue
    const confirmation = pauseConfirmationFor(history, mandate, request)
    if (confirmation !== null) return confirmation
  }
  return null
}

export function unliftedPause(history: DecodedHistory, mandate: MandateRecord): ControlRecord | null {
  for (const request of controlsOf(history)) {
    if (!pauseRequestFor(mandate, request)) continue
    const confirmation = pauseConfirmationFor(history, mandate, request)
    if (confirmation !== null && !pauseLifted(history, confirmation)) return confirmation
  }
  return null
}

export function outstandingPauseRequest(history: DecodedHistory, mandate: MandateRecord): ControlRecord | null {
  return (
    controlsOf(history).find(
      (record) => pauseRequestFor(mandate, record) && pauseConfirmationFor(history, mandate, record) === null,
    ) ?? null
  )
}

export function outstandingPauseInAuthority(
  mandate: MandateRecord,
  histories: readonly DecodedHistory[],
  seen: ReadonlySet<string> = new Set(),
): Diagnostic | null {
  const scope = mandateScope(mandate)
  const key = `${scope.repository}\0${scope.target}\0${mandate.recordId}`
  if (seen.has(key)) return null
  const home = historyFor(scope, histories)
  if (home === null) return null
  if (outstandingPauseRequest(home, mandate) !== null)
    return diagnostic('pause-unconfirmed', `Mandate ${mandate.recordId} has an unconfirmed pause request`)
  if (mandate.payload.parent === null) return null
  const parentHistory = historyFor(mandate.payload.parent.scope, histories)
  if (parentHistory === null) return null
  const parent = bindExternalRef(mandate.payload.parent, parentHistory)
  if (!parent.ok || parent.value.kind !== 'mandate') return null
  const nextSeen = new Set(seen)
  nextSeen.add(key)
  return outstandingPauseInAuthority(parent.value, histories, nextSeen)
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
