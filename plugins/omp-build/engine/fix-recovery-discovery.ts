import { canonicalValueDigest } from './action-input.ts'
import { authenticateSourceBasis } from './fix-recovery-discovery-authentication.ts'
import { deriveObservedPhase, validateSettledPublications } from './fix-recovery-discovery-evidence.ts'
import {
  asOpenedRef,
  completeTrustedRecords,
  findOwnerPairs,
  identityKey,
  type OwnerPair,
  sameIdentity,
  scopeKey,
} from './fix-recovery-discovery-records.ts'
import { commentAsPartPin, partPinsEqual } from './fix-recovery-part-pins.ts'
import type { InterruptedPhase } from './fix-recovery-phase-schema.ts'
import type { OpenedRef, SettledRef } from './fix-recovery-schema.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope, sameRef } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Diagnostic, Scope } from './record-values.ts'
import type { SpecEffective } from './spec-effective-schema.ts'
import type { UwGraphObservation, UwSemanticGraph } from './uw-graph.ts'
import { bindExternalRef } from './workflow-control.ts'
import { scopedRefsOf } from './workflow-record-references.ts'

export type FixRecoveryDiscoveryInput = Readonly<{
  uw: Scope
  histories: readonly DecodedHistory[]
  graph: UwGraphObservation
}>

export type HistoricalDiscoveryInput = Readonly<{
  uw: Scope
  histories: readonly DecodedHistory[]
  accepted: SpecEffective
  graph: UwSemanticGraph
  opened: OpenedRef
}>
export type SelectedCurrentInput = FixRecoveryDiscoveryInput & Readonly<{ opened: OpenedRef }>

export type FixRecoveryRead =
  | { status: 'none' }
  | { status: 'blocked'; diagnostics: readonly Diagnostic[] }
  | {
      status: 'interrupted'
      phase: InterruptedPhase
      owner: OpenedRef
      settled: SettledRef
    }

export function fixRecoveryDiscoveryScopes(records: readonly CanonicalRecord[]): Scope[] {
  const scopes = new Map<string, Scope>()
  const add = (scope: Scope) => scopes.set(scopeKey(scope), scope)
  for (const record of records) {
    if (record.kind === 'fix-owner' && record.payload.phase === 'opened') {
      add(record.payload.common.uw)
      add(record.payload.common.pullRequest)
      for (const scope of record.payload.common.writeScopes) add(scope)
    }
    if (record.kind === 'fix-recovery') for (const cut of record.payload.observation.histories) add(cut.scope)
  }
  return [...scopes.values()]
}

type DiscoveryInput = FixRecoveryDiscoveryInput | HistoricalDiscoveryInput | SelectedCurrentInput

function duplicateOpenings(ownerRecords: readonly CanonicalRecord[]): boolean {
  const openingKeys = new Set<string>()
  for (const record of ownerRecords) {
    if (record.kind !== 'fix-owner' || record.payload.phase !== 'opened') continue
    const key = `${scopeKey(record)}\0${record.recordId}`
    if (openingKeys.has(key)) return true
    openingKeys.add(key)
  }
  return false
}

function selectOwner(
  input: DiscoveryInput,
  histories: readonly DecodedHistory[],
  records: readonly CanonicalRecord[],
): FixRecoveryRead | { pair: OwnerPair } {
  const ownerRecords = records.filter((record) => record.kind === 'fix-owner' && equalScope(record, input.uw))
  const ownerClaims = histories
    .filter((history) => equalScope(history.source.scope, input.uw))
    .flatMap((history) =>
      history.operations.filter(
        (operation) =>
          operation.authority !== 'foreign' &&
          (operation.kind === 'fix-owner' || operation.claimedKinds.includes('fix-owner')),
      ),
    )
  if (ownerClaims.length !== ownerRecords.length || ownerClaims.some((operation) => operation.status !== 'complete'))
    return {
      status: 'blocked',
      diagnostics: [diagnostic('unconfirmed', 'An owner claim is incomplete or cannot be authenticated')],
    }
  if (duplicateOpenings(ownerRecords))
    return {
      status: 'blocked',
      diagnostics: [diagnostic('ambiguous', 'Duplicate owner openings cannot authenticate recovery')],
    }
  const allPairs = findOwnerPairs(ownerRecords)
  const pairs =
    'opened' in input ? allPairs.filter((entry) => sameRef(asOpenedRef(entry.opened), input.opened)) : allPairs
  if (!('opened' in input) && ownerRecords.length > 0 && (ownerRecords.length !== 2 || pairs.length !== 1))
    return {
      status: 'blocked',
      diagnostics: [diagnostic('ambiguous', 'Owner claims do not identify one complete opening and settlement')],
    }
  if (pairs.length === 0) {
    const claimed = histories.some(
      (history) =>
        equalScope(history.source.scope, input.uw) &&
        history.operations.some(
          (operation) =>
            operation.authority !== 'foreign' &&
            (operation.kind === 'fix-owner' || operation.claimedKinds.includes('fix-owner')),
        ),
    )
    return claimed
      ? {
          status: 'blocked',
          diagnostics: [diagnostic('unconfirmed', 'Owner lifecycle has no authenticated opening and settlement')],
        }
      : { status: 'none' }
  }
  if (pairs.length > 1) {
    return {
      status: 'blocked',
      diagnostics: [
        diagnostic('ambiguous', 'Multiple authenticated owner openings are settled without a unique recovery root'),
      ],
    }
  }
  const pair = pairs[0]
  return pair === undefined ? { status: 'none' } : { pair }
}

function validateRawParts(histories: readonly DecodedHistory[]): FixRecoveryRead | null {
  for (const history of histories) {
    for (const operation of history.operations) {
      if (operation.authority === 'foreign') continue
      for (const part of operation.parts) {
        const pin = commentAsPartPin(part)
        if (
          pin === null ||
          history.source.comments.filter((comment) => {
            const sourcePin = commentAsPartPin(comment)
            return sourcePin !== null && partPinsEqual(sourcePin, pin)
          }).length !== 1
        )
          return {
            status: 'blocked',
            diagnostics: [
              diagnostic('unconfirmed', 'Protocol operation part is not uniquely present in the raw native source'),
            ],
          }
      }
    }
  }
  return null
}

function validateOwnerSources(
  input: DiscoveryInput,
  pair: OwnerPair,
  histories: readonly DecodedHistory[],
  byScope: Map<string, DecodedHistory>,
): FixRecoveryRead | null {
  const common = pair.opened.payload.common
  if (pair.settled.runId !== pair.opened.runId || !equalScope(pair.settled, common.uw))
    return {
      status: 'blocked',
      diagnostics: [diagnostic('unbound', 'Settlement does not belong to its opening run and UW')],
    }
  for (const scope of common.writeScopes) {
    const history = byScope.get(scopeKey(scope))
    if (history === undefined || !history.source.complete)
      return {
        status: 'blocked',
        diagnostics: [diagnostic('incomplete', 'Recovery write scope lacks a complete native read')],
      }
  }
  const sourceProblem = authenticateSourceBasis(input, pair, histories)
  if (sourceProblem !== null) return { status: 'blocked', diagnostics: [sourceProblem] }
  for (const anchor of [pair.opened, pair.settled]) {
    for (const reference of scopedRefsOf(anchor)) {
      const home = byScope.get(scopeKey(reference.scope))
      if (home === undefined || !bindExternalRef(reference, home).ok)
        return {
          status: 'blocked',
          diagnostics: [
            diagnostic('unconfirmed', `Complete recovery reference ${reference.recordId} is not authenticated`),
          ],
        }
    }
  }
  return null
}

function validateOutboundIdentities(pair: OwnerPair, histories: readonly DecodedHistory[]): FixRecoveryRead | null {
  const common = pair.opened.payload.common
  const outboundKeys = new Set<string>()
  const outboundOperationKeys = new Set<string>()
  const outboundRecordKeys = new Set<string>()
  for (const outbound of pair.settled.payload.outbound) {
    const key = identityKey(outbound.identity)
    const operationKey = `${scopeKey(outbound.identity.scope)}\0${outbound.identity.operationId}`
    const recordKey = `${scopeKey(outbound.identity.scope)}\0${outbound.identity.recordId}`
    if (
      outboundKeys.has(key) ||
      outboundOperationKeys.has(operationKey) ||
      outboundRecordKeys.has(recordKey) ||
      outbound.identity.runId !== pair.opened.runId ||
      !common.writeScopes.some((scope) => equalScope(scope, outbound.identity.scope))
    )
      return {
        status: 'blocked',
        diagnostics: [diagnostic('ambiguous', 'Outbound operation has duplicate or foreign ownership')],
      }
    outboundKeys.add(key)
    outboundOperationKeys.add(operationKey)
    outboundRecordKeys.add(recordKey)
    const matching = histories
      .filter((history) => equalScope(history.source.scope, outbound.identity.scope))
      .flatMap((history) =>
        history.operations.filter(
          (operation) =>
            operation.authority !== 'foreign' &&
            (operation.operationId === outbound.identity.operationId ||
              operation.recordId === outbound.identity.recordId),
        ),
      )
    if (
      matching.length > 1 ||
      matching.some(
        (operation) =>
          operation.operationId !== outbound.identity.operationId ||
          operation.recordId !== outbound.identity.recordId ||
          operation.kind !== outbound.identity.kind ||
          (operation.record !== null && !sameIdentity(outbound.identity, operation.record)),
      )
    )
      return {
        status: 'blocked',
        diagnostics: [diagnostic('ambiguous', 'Outbound identity collides with another operation')],
      }
  }
  return null
}

function discoverSnapshot(input: DiscoveryInput): FixRecoveryRead {
  const byScope = new Map<string, DecodedHistory>()
  for (const history of input.histories) {
    const key = scopeKey(history.source.scope)
    const previous = byScope.get(key)
    if (previous !== undefined && canonicalValueDigest(previous) !== canonicalValueDigest(history))
      return {
        status: 'blocked',
        diagnostics: [diagnostic('ambiguous', 'Conflicting observations of the same history scope')],
      }
    byScope.set(key, history)
  }
  const histories = [...byScope.values()]
  const selected = selectOwner(input, histories, completeTrustedRecords(histories))
  if (!('pair' in selected)) return selected
  const { pair } = selected
  const parts = validateRawParts(histories)
  if (parts !== null) return parts
  const sources = validateOwnerSources(input, pair, histories, byScope)
  if (sources !== null) return sources
  const outbound = validateOutboundIdentities(pair, histories)
  if (outbound !== null) return outbound
  const publications = validateSettledPublications(pair, histories)
  if (publications !== null) return publications
  return deriveObservedPhase(pair, histories)
}

export function discoverFixRecovery(input: FixRecoveryDiscoveryInput): FixRecoveryRead {
  return discoverSnapshot(input)
}

/** Caller must first authenticate the complete owner lineage that selects this opening. */
export function discoverSelectedRecoveryOwner(input: SelectedCurrentInput): FixRecoveryRead {
  return discoverSnapshot(input)
}

/** Internal finite-cut derivation; not a live read or authority to execute. */
export function discoverRecoveryHistoricalSnapshot(input: HistoricalDiscoveryInput): FixRecoveryRead {
  return discoverSnapshot(input)
}
