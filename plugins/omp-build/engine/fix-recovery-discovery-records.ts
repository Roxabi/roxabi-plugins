import { canonicalValueDigest } from './action-input.ts'
import type { PartPin, RecordPin, ReservedRecordIdentity } from './fix-recovery-identities.ts'
import { commentAsPartPin, observedPartsMatch } from './fix-recovery-part-pins.ts'
import type { FixOwnerOpenedPayload, FixOwnerSettledPayload, OpenedRef, SettledRef } from './fix-recovery-schema.ts'
import type { DecodedHistory, OperationRead } from './history-schema.ts'
import { equalScope, sameRef } from './record-diagnostics.ts'
import { recordIntegrity } from './record-integrity.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Scope } from './record-values.ts'
import { bindExternalRef } from './workflow-control.ts'

type OwnerRecord = Extract<CanonicalRecord, { kind: 'fix-owner' }>
export type OpenedRecord = Omit<OwnerRecord, 'payload'> & { payload: FixOwnerOpenedPayload }
type SettledRecord = Omit<OwnerRecord, 'payload'> & { payload: FixOwnerSettledPayload }
export type OwnerPair = { opened: OpenedRecord; settled: SettledRecord }

export const scopeKey = (scope: Scope) => `${scope.repository}\0${scope.target}`

export function identityKey(identity: ReservedRecordIdentity<string>): string {
  return `${scopeKey(identity.scope)}\0${identity.kind}\0${identity.runId}\0${identity.operationId}\0${identity.recordId}`
}

export function asOpenedRef(record: CanonicalRecord): OpenedRef {
  return {
    scope: { repository: record.repository, target: record.target },
    kind: 'fix-owner',
    recordId: record.recordId,
  }
}

export function asSettledRef(record: CanonicalRecord): SettledRef {
  return {
    scope: { repository: record.repository, target: record.target },
    kind: 'fix-owner',
    recordId: record.recordId,
  }
}

export function completeTrustedRecords(histories: readonly DecodedHistory[]): CanonicalRecord[] {
  const records: CanonicalRecord[] = []
  for (const history of histories) {
    for (const operation of history.operations) {
      if (operation.authority === 'foreign') continue
      if (
        operation.status !== 'complete' ||
        operation.record === null ||
        recordIntegrity(operation.parts, operation.record) !== null ||
        operation.parts.some((part) => commentAsPartPin(part) === null)
      )
        continue
      records.push(operation.record)
    }
  }
  return records
}

function pairForSettlement(settlement: SettledRecord, opened: Map<string, OpenedRecord[]>): OwnerPair | null {
  if (settlement.payload.phase !== 'settled') return null
  if (!sameRef(settlement.payload.opened, settlement.payload.interrupted.opened)) return null
  const key = `${scopeKey(settlement.payload.opened.scope)}\0${settlement.payload.opened.recordId}`
  const openings = opened.get(key) ?? []
  if (openings.length !== 1) return null
  const opening = openings[0]
  if (opening === undefined || opening.payload.phase !== 'opened') return null
  if (
    opening.payload.common.owner.recordId !== opening.recordId ||
    opening.payload.common.owner.runId !== opening.runId ||
    opening.payload.common.owner.operationId !== opening.operationId ||
    scopeKey(opening.payload.common.owner.scope) !==
      scopeKey({ repository: opening.repository, target: opening.target })
  )
    return null
  return { opened: opening, settled: settlement }
}

export function findOwnerPairs(records: readonly CanonicalRecord[]): OwnerPair[] {
  const opened = new Map<string, OpenedRecord[]>()
  const settled: SettledRecord[] = []
  for (const record of records) {
    if (record.kind !== 'fix-owner') continue
    if (record.payload.phase === 'opened') {
      const key = `${scopeKey({ repository: record.repository, target: record.target })}\0${record.recordId}`
      opened.set(key, [...(opened.get(key) ?? []), { ...record, payload: record.payload }])
    } else settled.push({ ...record, payload: record.payload })
  }
  const pairs: OwnerPair[] = []
  for (const settlement of settled) {
    const pair = pairForSettlement(settlement, opened)
    if (pair !== null) pairs.push(pair)
  }
  return pairs
}

export function sameIdentity(
  left: ReservedRecordIdentity<string>,
  right: { repository: string; target: string; kind: string; runId: string; operationId: string; recordId: string },
): boolean {
  return (
    left.kind === right.kind &&
    left.runId === right.runId &&
    left.operationId === right.operationId &&
    left.recordId === right.recordId &&
    equalScope(left.scope, { repository: right.repository, target: right.target })
  )
}

export function findOperation(
  histories: readonly DecodedHistory[],
  identity: ReservedRecordIdentity<string>,
): OperationRead | null {
  for (const history of histories) {
    if (!equalScope(history.source.scope, identity.scope)) continue
    const operation = history.operations.find(
      (entry) =>
        entry.authority !== 'foreign' &&
        entry.operationId === identity.operationId &&
        entry.recordId === identity.recordId &&
        (entry.kind === null || entry.kind === identity.kind),
    )
    if (operation !== undefined) return operation
  }
  return null
}

export function findCompleteRecord(
  histories: readonly DecodedHistory[],
  identity: ReservedRecordIdentity<string>,
): CanonicalRecord | null {
  const operation = findOperation(histories, identity)
  if (
    operation === null ||
    operation.status !== 'complete' ||
    operation.record === null ||
    recordIntegrity(operation.parts, operation.record) !== null ||
    operation.parts.some((part) => commentAsPartPin(part) === null)
  )
    return null
  if (!sameIdentity(identity, operation.record)) return null
  const home = histories.find((history) => equalScope(history.source.scope, identity.scope))
  if (home === undefined) return null
  const bound = bindExternalRef(
    { scope: identity.scope, kind: operation.record.kind, recordId: identity.recordId },
    home,
  )
  if (!bound.ok || canonicalValueDigest(bound.value) !== canonicalValueDigest(operation.record)) return null
  return operation.record
}

export function pinForComplete<K extends string>(
  identity: ReservedRecordIdentity<K>,
  record: CanonicalRecord,
  operation: OperationRead,
): RecordPin<K> {
  const parts = operation.parts.map(commentAsPartPin)
  if (parts.some((entry) => entry === null)) {
    throw new Error('complete operation lacks pinable publication parts')
  }
  return {
    identity,
    envelopeDigest: canonicalValueDigest(record),
    parts: parts as PartPin[],
  }
}

export function matchesCompletePin(histories: readonly DecodedHistory[], pin: RecordPin<string>): boolean {
  const record = findCompleteRecord(histories, pin.identity)
  const operation = findOperation(histories, pin.identity)
  return (
    record !== null &&
    operation !== null &&
    canonicalValueDigest(record) === pin.envelopeDigest &&
    observedPartsMatch(pin.parts, operation)
  )
}
