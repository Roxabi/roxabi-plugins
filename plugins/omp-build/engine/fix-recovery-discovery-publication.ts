import { findCompleteRecord, findOperation, identityKey, pinForComplete } from './fix-recovery-discovery-records.ts'
import type { PartPin, ReservedRecordIdentity } from './fix-recovery-identities.ts'
import { commentAsPartPin, observedPartsMatch } from './fix-recovery-part-pins.ts'
import type { InterruptedPhase, OutboundOperation } from './fix-recovery-phase-schema.ts'
import type { OpenedRef } from './fix-recovery-schema.ts'
import type { DecodedHistory, OperationRead } from './history-schema.ts'
import { diagnostic } from './record-diagnostics.ts'
import type { Diagnostic } from './record-values.ts'

type PublicationPrefix = Extract<InterruptedPhase, { kind: 'publication-prefix' }>
type Result<T> = { ok: true; value: T } | { ok: false; diagnostics: Diagnostic[] }
type Unconfirmed<K extends 'contribution' | 'fix-request'> =
  | { state: 'not-submitted'; reservation: ReservedRecordIdentity<K> }
  | { state: 'submitted-unconfirmed'; reservation: ReservedRecordIdentity<K>; observedParts: PartPin[] }

function deriveReserved<K extends 'contribution' | 'fix-request'>(
  reservation: ReservedRecordIdentity<K>,
  operation: OperationRead | null,
  label: 'source' | 'request',
): Result<Unconfirmed<K>> {
  if (operation === null) return { ok: true, value: { state: 'not-submitted', reservation } }
  const parts = operation.parts.map(commentAsPartPin).filter((part): part is PartPin => part !== null)
  if (operation.status !== 'incomplete' || parts.length !== operation.parts.length) {
    return {
      ok: false,
      diagnostics: [diagnostic('ambiguous', `Observed ${label} reservation is not a pinnable incomplete operation`)],
    }
  }
  return { ok: true, value: { state: 'submitted-unconfirmed', reservation, observedParts: parts } }
}

function deriveUnconfirmed<K extends 'contribution' | 'fix-request'>(
  reservation: ReservedRecordIdentity<K>,
  publication: OutboundOperation['publication'],
  operation: OperationRead | null,
  label: 'source' | 'request',
): Result<Unconfirmed<K>> {
  if (publication.state === 'reserved') return deriveReserved(reservation, operation, label)
  if (publication.state === 'submitted-unconfirmed') {
    if (
      (operation === null && publication.observedParts.length !== 0) ||
      (operation !== null &&
        (operation.status !== 'incomplete' || !observedPartsMatch(publication.observedParts, operation, false)))
    ) {
      return {
        ok: false,
        diagnostics: [diagnostic('ambiguous', `Observed ${label} parts do not match the settled pin`)],
      }
    }
    return {
      ok: true,
      value: {
        state: 'submitted-unconfirmed',
        reservation,
        observedParts:
          operation === null
            ? []
            : operation.parts.map(commentAsPartPin).filter((part): part is PartPin => part !== null),
      },
    }
  }
  return label === 'source'
    ? {
        ok: false,
        diagnostics: [diagnostic('incomplete', 'Source publication state cannot authenticate a publication prefix')],
      }
    : { ok: false, diagnostics: [diagnostic('ambiguous', 'Confirmed request cannot remain in publication-prefix')] }
}

function deriveSource(
  reservation: ReservedRecordIdentity<'contribution'>,
  publication: OutboundOperation['publication'],
  histories: readonly DecodedHistory[],
): Result<PublicationPrefix['source']> {
  const complete = findCompleteRecord(histories, reservation)
  const operation = findOperation(histories, reservation)
  if (complete !== null && operation !== null && operation.status === 'complete') {
    return { ok: true, value: { state: 'complete', record: pinForComplete(reservation, complete, operation) } }
  }
  return deriveUnconfirmed(reservation, publication, operation, 'source')
}

export function derivePublicationPrefix(
  opened: OpenedRef,
  sourceReservation: ReservedRecordIdentity<'contribution'>,
  requestReservation: ReservedRecordIdentity<'fix-request'>,
  outbound: readonly OutboundOperation[],
  histories: readonly DecodedHistory[],
): { ok: true; value: InterruptedPhase } | { ok: false; diagnostics: Diagnostic[] } {
  const sourceOutbound = outbound.find((entry) => identityKey(entry.identity) === identityKey(sourceReservation))
  const requestOutbound = outbound.find((entry) => identityKey(entry.identity) === identityKey(requestReservation))
  if (sourceOutbound === undefined || requestOutbound === undefined) {
    return {
      ok: false,
      diagnostics: [diagnostic('incomplete', 'Settled outbound manifest is missing reserved source or request')],
    }
  }
  if (findCompleteRecord(histories, requestReservation) !== null) {
    return {
      ok: false,
      diagnostics: [
        diagnostic('ambiguous', 'Complete request exists; publication-prefix is not the authenticated phase'),
      ],
    }
  }
  const source = deriveSource(sourceReservation, sourceOutbound.publication, histories)
  if (!source.ok) return source
  const requestOperation =
    requestOutbound.publication.state === 'reserved' || requestOutbound.publication.state === 'submitted-unconfirmed'
      ? findOperation(histories, requestReservation)
      : null
  const request = deriveUnconfirmed(requestReservation, requestOutbound.publication, requestOperation, 'request')
  if (!request.ok) return request
  return { ok: true, value: { kind: 'publication-prefix', opened, source: source.value, request: request.value } }
}
