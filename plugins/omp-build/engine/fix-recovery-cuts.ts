import { canonicalValueDigest } from './action-input.ts'
import type { ScopeCut } from './fix-recovery-control-schema.ts'
import { matchesCompletePin } from './fix-recovery-discovery-records.ts'
import type { ReservedRecordIdentity } from './fix-recovery-identities.ts'
import { commentAsPartPin, observedPartsMatch, partPinsEqual } from './fix-recovery-part-pins.ts'
import type { FixOwnerOpenedPayload, FixOwnerSettledPayload } from './fix-recovery-schema.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope, sameRef } from './record-diagnostics.ts'
import type { Result } from './result.ts'
import { scopeKey } from './uw-graph.ts'

function identityKey(identity: ReservedRecordIdentity<string>): string {
  return [scopeKey(identity.scope), identity.kind, identity.runId, identity.operationId, identity.recordId].join('\0')
}

/** Validate complete manifest coverage against the immutable finite snapshot, not live history. */
export function validRecoveryCuts(
  cuts: readonly ScopeCut[],
  opening: FixOwnerOpenedPayload,
  settlement: FixOwnerSettledPayload,
  histories: readonly DecodedHistory[],
): boolean {
  const scopes = opening.common.writeScopes.map(scopeKey).sort()
  if (
    cuts.length !== scopes.length ||
    cuts.some((cut, index) => scopeKey(cut.scope) !== scopes[index] || !sameRef(cut.retiringOpened, settlement.opened))
  )
    return false
  const manifest = settlement.outbound.map((entry) => identityKey(entry.identity)).sort()
  if (new Set(manifest).size !== manifest.length) return false
  const covered: string[] = []
  for (const cut of cuts) {
    const history = histories.find((entry) => equalScope(entry.source.scope, cut.scope))
    if (history === undefined) return false
    if (!validateCutMembers(cut, history, histories, covered)) return false
  }
  covered.sort()
  return covered.length === manifest.length && covered.every((key, index) => key === manifest[index])
}

/** Derive exact manifest membership from the observed finite cut; this is not control authority. */
export function makeRecoveryCuts(
  opening: FixOwnerOpenedPayload,
  settlement: FixOwnerSettledPayload,
  histories: readonly DecodedHistory[],
): Result<ScopeCut[]> {
  const fail = cutFailure
  const cuts: ScopeCut[] = opening.common.writeScopes.map((scope) => ({
    scope: { ...scope },
    retiringOpened: settlement.opened,
    members: [],
  }))
  cuts.sort((a, b) => (scopeKey(a.scope) < scopeKey(b.scope) ? -1 : scopeKey(a.scope) > scopeKey(b.scope) ? 1 : 0))
  for (const entry of settlement.outbound) {
    const identity = entry.identity
    const cut = cuts.find((candidate) => equalScope(candidate.scope, identity.scope))
    const homes = histories.filter((history) => equalScope(history.source.scope, identity.scope))
    const home = homes[0]
    if (cut === undefined || homes.length !== 1 || home === undefined || !home.source.complete) return fail()
    const member = makeCutMember(entry, home, histories)
    if (!member.ok) return member
    cut.members.push(member.value)
  }
  for (const cut of cuts)
    cut.members.sort((a, b) => {
      const left = identityKey(a.disposition === 'keep-complete' ? a.record.identity : a.identity)
      const right = identityKey(b.disposition === 'keep-complete' ? b.record.identity : b.identity)
      return left < right ? -1 : left > right ? 1 : 0
    })
  return validRecoveryCuts(cuts, opening, settlement, histories) ? { ok: true, value: cuts } : fail()
}

type CutMember = ScopeCut['members'][number]
type Outbound = FixOwnerSettledPayload['outbound'][number]
const cutFailure = (): Result<never> => ({
  ok: false,
  diagnostics: [diagnostic('unconfirmed', 'Recovery outbound manifest cannot be reconciled to its raw source')],
})

function validateCutMembers(
  cut: ScopeCut,
  history: DecodedHistory,
  histories: readonly DecodedHistory[],
  covered: string[],
): boolean {
  let previous: string | null = null
  for (const member of cut.members) {
    if (!orderedMemberParts(member)) return false
    const identity = member.disposition === 'keep-complete' ? member.record.identity : member.identity
    const key = identityKey(identity)
    if (!equalScope(identity.scope, cut.scope) || (previous !== null && previous >= key)) return false
    previous = key
    covered.push(key)
    if (!authenticatedCutMember(member, history, histories)) return false
  }
  return true
}

function authenticatedCutMember(
  member: CutMember,
  history: DecodedHistory,
  histories: readonly DecodedHistory[],
): boolean {
  return member.disposition === 'keep-complete'
    ? matchesCompletePin(histories, member.record)
    : matchesIncompleteMember(member, history)
}

function orderedMemberParts(member: CutMember): boolean {
  const parts = member.disposition === 'keep-complete' ? member.record.parts : member.observedParts
  return !parts.some((part, index) => {
    const prior = parts[index - 1]
    return index > 0 && (prior === undefined || prior.part >= part.part || prior.total !== part.total)
  })
}

function matchesIncompleteMember(
  member: Extract<CutMember, { disposition: 'retire-incomplete' }>,
  history: DecodedHistory,
): boolean {
  const identity = member.identity
  const operations = history.operations.filter(
    (operation) =>
      operation.authority !== 'foreign' &&
      (operation.operationId === identity.operationId || operation.recordId === identity.recordId),
  )
  if (operations.length === 0) return member.observedParts.length === 0
  const operation = operations[0]
  return (
    operations.length === 1 &&
    operation !== undefined &&
    operation.status === 'incomplete' &&
    operation.operationId === identity.operationId &&
    operation.recordId === identity.recordId &&
    operation.kind === identity.kind &&
    observedPartsMatch(member.observedParts, operation)
  )
}

function makeCutMember(entry: Outbound, home: DecodedHistory, histories: readonly DecodedHistory[]): Result<CutMember> {
  const identity = entry.identity
  const operations = home.operations.filter(
    (operation) =>
      operation.authority !== 'foreign' &&
      (operation.operationId === identity.operationId || operation.recordId === identity.recordId),
  )
  if (operations.length > 1) return cutFailure()
  const operation = operations[0]
  if (operation === undefined) {
    if (
      entry.publication.state === 'confirmed' ||
      (entry.publication.state === 'submitted-unconfirmed' && entry.publication.observedParts.length > 0)
    )
      return cutFailure()
    return { ok: true, value: { disposition: 'retire-incomplete', identity, observedParts: [] } }
  }
  return makeObservedCutMember(entry, operation, home, histories)
}

function makeObservedCutMember(
  entry: Outbound,
  operation: DecodedHistory['operations'][number],
  home: DecodedHistory,
  histories: readonly DecodedHistory[],
): Result<CutMember> {
  const identity = entry.identity
  if (
    operation.operationId !== identity.operationId ||
    operation.recordId !== identity.recordId ||
    operation.kind !== identity.kind ||
    (operation.status !== 'complete' && operation.status !== 'incomplete')
  )
    return cutFailure()
  const pins = operation.parts.map(commentAsPartPin)
  if (pins.some((pin) => pin === null)) return cutFailure()
  const parts = pins.filter((pin) => pin !== null).sort((a, b) => a.part - b.part)
  if (!uniqueCutParts(parts, home)) return cutFailure()
  if (
    entry.publication.state === 'submitted-unconfirmed' &&
    !observedPartsMatch(entry.publication.observedParts, operation, false)
  )
    return cutFailure()
  if (operation.status === 'incomplete') {
    if (entry.publication.state === 'confirmed') return cutFailure()
    return { ok: true, value: { disposition: 'retire-incomplete', identity, observedParts: parts } }
  }
  if (operation.record === null) return cutFailure()
  const pin = { identity, envelopeDigest: canonicalValueDigest(operation.record), parts }
  if (
    !matchesCompletePin(histories, pin) ||
    (entry.publication.state === 'confirmed' &&
      canonicalValueDigest(entry.publication.record) !== canonicalValueDigest(pin))
  )
    return cutFailure()
  return { ok: true, value: { disposition: 'keep-complete', record: pin } }
}

function uniqueCutParts(
  parts: Extract<CutMember, { disposition: 'retire-incomplete' }>['observedParts'],
  home: DecodedHistory,
): boolean {
  return !parts.some((part, index) => {
    const previous = parts[index - 1]
    return (
      (index > 0 && (previous === undefined || previous.part === part.part)) ||
      home.source.comments.filter((comment) => {
        const actual = commentAsPartPin(comment)
        return actual !== null && partPinsEqual(actual, part)
      }).length !== 1
    )
  })
}
