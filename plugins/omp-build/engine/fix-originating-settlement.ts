import { canonicalValueDigest } from './action-input.ts'
import { deriveFixOwnerSettlementFacts } from './fix-recovery-discovery-settlement.ts'
import { recoveryRetiredParts } from './fix-recovery-projection.ts'
import { frameFrom } from './history-framing.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Scope } from './record-values.ts'
import type { Result } from './result.ts'
import { bindExternalRef } from './workflow-control.ts'

const fail = (message: string): Result<never> => ({ ok: false, diagnostics: [diagnostic('unconfirmed', message)] })
/** Reconcile an originating settlement with raw sources; this does not grant host or execution authority. */
export function validateOriginatingFixSettlement(input: {
  record: Extract<CanonicalRecord, { kind: 'fix-owner' }>
  histories: readonly DecodedHistory[]
}): Result<true> {
  const { record, histories } = input
  if (record.payload.phase !== 'settled') return fail('Originating settlement has the wrong phase')
  const settlement = record.payload
  const homes = histories.filter((history) => equalScope(history.source.scope, settlement.opened.scope))
  const home = homes[0]
  if (homes.length !== 1 || home === undefined || !home.source.complete)
    return fail('Originating settlement owner source is unavailable')
  const opened = bindExternalRef(settlement.opened, home)
  if (!opened.ok) return opened
  if (
    opened.value.kind !== 'fix-owner' ||
    opened.value.payload.phase !== 'opened' ||
    !equalScope(record, opened.value) ||
    record.runId !== opened.value.runId ||
    record.operationId !== `${opened.value.payload.common.operationPrefix}-${record.recordId}`
  )
    return fail('Originating settlement does not belong to its opening')
  const opening = { ...opened.value, payload: opened.value.payload }
  const sources = validateNativeSources(histories)
  if (!sources.ok) return sources
  const facts = deriveFixOwnerSettlementFacts({
    opening,
    histories,
    reservations: settlement.outbound.map((entry) => ({
      identity: entry.identity,
      submitted: entry.publication.state !== 'reserved',
    })),
  })
  if (!facts.ok) return facts
  if (
    canonicalValueDigest(facts.value.outbound) !== canonicalValueDigest(settlement.outbound) ||
    canonicalValueDigest(facts.value.interrupted) !== canonicalValueDigest(settlement.interrupted)
  )
    return fail('Originating settlement differs from the current raw publication facts')
  const retired = recoveryRetiredParts(histories)
  if (!retired.ok) return retired
  for (const history of histories) {
    const trusted = validateTrustedHistory(history, settlement, retired.value)
    if (!trusted.ok) return trusted
  }
  return { ok: true, value: true }
}

function validateNativeSources(histories: readonly DecodedHistory[]): Result<true> {
  const identities = new Set<string>()
  for (const history of histories) {
    const key = JSON.stringify([history.source.scope.repository, history.source.scope.target])
    if (identities.has(key) || !history.source.complete || history.source.diagnostics.length !== 0)
      return fail('Originating settlement requires unique complete native source observations')
    identities.add(key)
  }
  return { ok: true, value: true }
}

function validateTrustedHistory(
  history: DecodedHistory,
  settlement: Extract<CanonicalRecord, { kind: 'fix-owner' }>['payload'] & { phase: 'settled' },
  retired: ReadonlyMap<string, ReadonlySet<string>>,
): Result<true> {
  const allowed = new Set<string>()
  for (const operation of history.operations) {
    if (operation.authority === 'foreign' || operation.status === 'complete') continue
    const enrolled = settlement.outbound.some(
      (entry) =>
        entry.publication.state === 'submitted-unconfirmed' &&
        equalScope(entry.identity.scope, history.source.scope) &&
        entry.identity.operationId === operation.operationId &&
        entry.identity.recordId === operation.recordId &&
        entry.identity.kind === operation.kind,
    )
    const previouslyRetired =
      operation.parts.length > 0 &&
      operation.parts.every(
        (part) =>
          part.nativeId !== null && retired.get(scopeKeyForSettlement(history.source.scope))?.has(part.nativeId),
      )
    if (operation.status !== 'incomplete' || (!enrolled && !previouslyRetired) || operation.operationId === null)
      return fail('Originating settlement contains an unrelated or ambiguous trusted operation')
    allowed.add(operation.operationId)
  }
  if (
    history.diagnostics.some(
      (entry) => entry.code !== 'incomplete' || entry.operationId === undefined || !allowed.has(entry.operationId),
    )
  )
    return fail('Originating settlement contains an unrelated trusted history diagnostic')
  return validateTrustedFrames(history)
}

function validateTrustedFrames(history: DecodedHistory): Result<true> {
  for (const comment of history.source.comments) {
    if (comment.author !== history.source.expectedAuthor && comment.author !== history.source.stopAuthor) continue
    const frame = frameFrom(comment)
    if (frame === null) continue
    if (
      'diagnostic' in frame ||
      comment.nativeId === null ||
      history.operations.filter((operation) => operation.parts.some((part) => part.nativeId === comment.nativeId))
        .length !== 1
    )
      return fail('Originating settlement contains unaccounted trusted framing')
  }
  return { ok: true, value: true }
}

function scopeKeyForSettlement(scope: Scope): string {
  return `${scope.repository}\0${scope.target}`
}
