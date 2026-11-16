import { canonicalValueDigest } from './action-input.ts'
import { deriveInterruptedPhase } from './fix-recovery-discovery-phase.ts'
import {
  asOpenedRef,
  findCompleteRecord,
  identityKey,
  type OpenedRecord,
  pinForComplete,
  sameIdentity,
  scopeKey,
} from './fix-recovery-discovery-records.ts'
import { commentAsPartPin } from './fix-recovery-part-pins.ts'
import type { InterruptedPhase, OutboundOperation } from './fix-recovery-phase-schema.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope } from './record-diagnostics.ts'
import type { Diagnostic } from './record-values.ts'
import { bindExternalRef } from './workflow-control.ts'

type Reservation = { identity: OutboundOperation['identity']; submitted: boolean }
type SettlementFailure = { ok: false; diagnostics: Diagnostic[] }
type ReservationKeys = { identities: Set<string>; operations: Set<string>; records: Set<string> }

function reservationPublication(
  entry: Reservation,
  operation: DecodedHistory['operations'][number] | undefined,
  histories: readonly DecodedHistory[],
): { ok: true; value: OutboundOperation } | SettlementFailure {
  const { identity } = entry
  if (operation !== undefined && !entry.submitted)
    return { ok: false, diagnostics: [diagnostic('ambiguous', 'Observed publication was not enrolled as submitted')] }
  const complete = findCompleteRecord(histories, identity)
  if (complete !== null && operation !== undefined)
    return {
      ok: true,
      value: { identity, publication: { state: 'confirmed', record: pinForComplete(identity, complete, operation) } },
    }
  if (!entry.submitted) return { ok: true, value: { identity, publication: { state: 'reserved' } } }
  const parts = operation?.parts.map(commentAsPartPin) ?? []
  if (parts.some((part) => part === null))
    return { ok: false, diagnostics: [diagnostic('incomplete', 'Submitted publication has an unpinnable native part')] }
  return {
    ok: true,
    value: {
      identity,
      publication: { state: 'submitted-unconfirmed', observedParts: parts.filter((part) => part !== null) },
    },
  }
}

function settlementReservation(
  entry: Reservation,
  opening: OpenedRecord,
  histories: readonly DecodedHistory[],
  keys: ReservationKeys,
): { ok: true; value: OutboundOperation } | SettlementFailure {
  const identity = entry.identity
  const key = identityKey(identity)
  const operationKey = `${scopeKey(identity.scope)}\0${identity.operationId}`
  const recordKey = `${scopeKey(identity.scope)}\0${identity.recordId}`
  const sources = histories.filter((history) => equalScope(history.source.scope, identity.scope))
  const source = sources[0]
  if (
    keys.identities.has(key) ||
    keys.operations.has(operationKey) ||
    keys.records.has(recordKey) ||
    identity.runId !== opening.runId ||
    !opening.payload.common.writeScopes.some((scope) => equalScope(scope, identity.scope)) ||
    sources.length !== 1 ||
    source === undefined ||
    !source.source.complete
  )
    return {
      ok: false,
      diagnostics: [
        diagnostic('ambiguous', 'Owner reservation is duplicated, foreign or lacks a complete source observation'),
      ],
    }
  keys.identities.add(key)
  keys.operations.add(operationKey)
  keys.records.add(recordKey)
  const matches = source.operations.filter(
    (operation) =>
      operation.authority !== 'foreign' &&
      (operation.operationId === identity.operationId || operation.recordId === identity.recordId),
  )
  if (
    matches.length > 1 ||
    matches.some(
      (operation) =>
        operation.operationId !== identity.operationId ||
        operation.recordId !== identity.recordId ||
        operation.kind !== identity.kind ||
        (operation.record !== null && !sameIdentity(identity, operation.record)),
    )
  )
    return { ok: false, diagnostics: [diagnostic('ambiguous', 'Owner reservation collides with another operation')] }
  return reservationPublication(entry, matches[0], histories)
}

/** Capture journal facts after the host has joined its enrolled publication effects. */
export function deriveFixOwnerSettlementFacts(input: {
  opening: OpenedRecord
  reservations: readonly { identity: OutboundOperation['identity']; submitted: boolean }[]
  histories: readonly DecodedHistory[]
}):
  | { ok: true; value: { outbound: OutboundOperation[]; interrupted: InterruptedPhase } }
  | { ok: false; diagnostics: Diagnostic[] } {
  const { opening, histories } = input
  if (opening.payload.common.host.kind !== 'linux-qualified')
    return {
      ok: false,
      diagnostics: [diagnostic('unconfirmed', 'Ordinary-only owners cannot provide bounded recovery settlement')],
    }
  const home = histories.filter((history) => equalScope(history.source.scope, opening.payload.common.uw))
  const anchor = home.length === 1 && home[0] !== undefined ? bindExternalRef(asOpenedRef(opening), home[0]) : null
  const completeOpening = findCompleteRecord(histories, opening.payload.common.owner)
  if (
    anchor === null ||
    !anchor.ok ||
    completeOpening === null ||
    canonicalValueDigest(anchor.value) !== canonicalValueDigest(opening) ||
    canonicalValueDigest(completeOpening) !== canonicalValueDigest(opening)
  )
    return { ok: false, diagnostics: [diagnostic('unconfirmed', 'Owner opening is not uniquely authenticated')] }
  const outbound: OutboundOperation[] = []
  const keys: ReservationKeys = { identities: new Set(), operations: new Set(), records: new Set() }
  for (const entry of input.reservations) {
    const result = settlementReservation(entry, opening, histories, keys)
    if (!result.ok) return result
    outbound.push(result.value)
  }
  const phase = deriveInterruptedPhase(opening, outbound, histories)
  return phase.ok ? { ok: true, value: { outbound, interrupted: phase.value } } : phase
}
