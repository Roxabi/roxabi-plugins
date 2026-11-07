import type { DecodedHistory } from './history-schema.ts'
import { sameRef } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Scope } from './record-values.ts'
import type { UwResult } from './uw-diagnostics.ts'
import { type FramingMembership, held, type MembershipContext, type MembershipInput } from './uw-framing-hold.ts'
import type { BoundFramingCoverageIntent, FramingReceiptRef } from './uw-framing-receipt-schema.ts'
import {
  conflict,
  diagnostic,
  type FramingRegistry,
  failed,
  receipts,
  reconstructFramingRegistry,
  ref,
} from './uw-framing-registry.ts'
import { resultCurrentHold } from './uw-framing-result-current.ts'
import { resultRecordHold } from './uw-framing-result-record.ts'
import type { FramingMemberKey } from './uw-framing-schema.ts'
import { sameScope } from './uw-graph.ts'
import type { FramingMemberAuthorization } from './uw-identity-schema.ts'

type Receipt = Extract<CanonicalRecord, { kind: 'framing-receipt' }>
type ResultPayload = Extract<Receipt['payload'], { phase: 'result' }>
type MemberBinding = { ref: FramingReceiptRef; payload: Extract<Receipt['payload'], { phase: 'member-binding' }> }
type Step<T> = { ok: true; value: T } | { ok: false; hold: FramingMembership }
function ownFacts(history: DecodedHistory): { facts: Receipt[]; identities: FramingMemberAuthorization[] } {
  const facts = receipts(history).filter(
    (record) =>
      record.payload.phase === 'intent' ||
      record.payload.phase === 'member-binding' ||
      record.payload.phase === 'member-claim',
  )
  const identities = history.operations.flatMap((op) =>
    op.authority !== 'foreign' &&
    op.status === 'complete' &&
    op.record?.kind === 'spec-identity' &&
    op.record.payload.format === 'omp-build-spec-identity/2'
      ? [op.record.payload.aggregate]
      : [],
  )
  return { facts, identities }
}
function factIntent(
  first: Receipt | undefined,
  identities: readonly FramingMemberAuthorization[],
): FramingReceiptRef | null {
  if (first === undefined) return identities[0]?.intent ?? null
  return first.payload.phase === 'intent' ? ref(first) : first.payload.intent
}
function registryFor(input: MembershipInput, intent: FramingReceiptRef): Step<FramingRegistry> {
  const roots = input.histories.filter((history) => sameScope(history.source.scope, intent.scope))
  const root = roots[0]
  if (roots.length !== 1 || root === undefined || failed(root))
    return { ok: false, hold: held(input.uw, 'framing-aggregate-unreadable', intent, null, [{ kind: 'root-history' }]) }
  const registry = reconstructFramingRegistry(root, intent)
  if (registry.ok) return { ok: true, value: registry.value }
  const unreadable = registry.diagnostics[0]?.code === 'framing-aggregate-unreadable'
  return {
    ok: false,
    hold: held(input.uw, unreadable ? 'framing-aggregate-unreadable' : 'framing-binding-conflict', intent, null),
  }
}
/** Every fact of this issue names the one intent, and no other issue homes a claim or result for it. */
function foreignFacts(
  histories: readonly DecodedHistory[],
  intent: FramingReceiptRef,
  facts: readonly Receipt[],
  identities: readonly FramingMemberAuthorization[],
): boolean {
  const relevant = facts.filter((record) =>
    record.payload.phase === 'intent' ? sameRef(ref(record), intent) : sameRef(record.payload.intent, intent),
  )
  const misplaced = histories.some(
    (history) =>
      !sameScope(history.source.scope, intent.scope) &&
      receipts(history).some(
        (r) =>
          (r.payload.phase === 'member-claim' || r.payload.phase === 'result') && sameRef(r.payload.intent, intent),
      ),
  )
  return (
    relevant.length !== facts.length || misplaced || identities.some((identity) => !sameRef(identity.intent, intent))
  )
}
function memberKey(
  uw: Scope,
  intent: FramingReceiptRef,
  registry: FramingRegistry,
  bindings: readonly MemberBinding[],
  identities: readonly FramingMemberAuthorization[],
): FramingMemberKey | null {
  if (sameScope(uw, intent.scope)) return registry.proposal.input.root
  return bindings[0]?.payload.member ?? identities[0]?.member ?? null
}
function claimHold(
  uw: Scope,
  intent: FramingReceiptRef,
  registry: FramingRegistry,
  member: FramingMemberKey,
  bindings: readonly MemberBinding[],
): FramingMembership | null {
  if (bindings.length > 1) return held(uw, 'framing-binding-conflict', intent, member)
  const isRoot = sameScope(uw, intent.scope)
  const binding = bindings[0]
  if (!isRoot && binding === undefined)
    return held(uw, 'framing-binding-unregistered', intent, member, [{ kind: 'binding', member }])
  if (
    binding !== undefined &&
    !isRoot &&
    (binding.payload.member !== member || binding.payload.memberDigest !== registry.members.get(member)?.memberDigest)
  )
    return held(uw, 'framing-binding-conflict', intent, member)
  const claim = registry.claims.get(member)
  const rebound = !isRoot && binding !== undefined && claim !== undefined && !sameRef(claim.binding, binding.ref)
  if (!claim || !sameScope(claim.scope, uw) || rebound)
    return held(uw, 'framing-binding-unregistered', intent, member, [{ kind: 'claim', member }])
  return null
}
function resultHold(ctx: MembershipContext, payload: ResultPayload): FramingMembership | null {
  return resultRecordHold(ctx, payload) ?? resultCurrentHold(ctx, payload)
}
export function readFramingMembership(input: MembershipInput): FramingMembership {
  const own = input.histories.filter((history) => sameScope(history.source.scope, input.uw))
  const history = own[0]
  if (own.length !== 1 || history === undefined || failed(history))
    return held(input.uw, 'framing-aggregate-unreadable', null, null, [{ kind: 'root-history' }])
  const { facts, identities } = ownFacts(history)
  if (!facts.length && !identities.length) return { status: 'none' }
  const intent = factIntent(facts[0], identities)
  if (intent === null) return held(input.uw, 'framing-binding-conflict', null, null)
  const registry = registryFor(input, intent)
  if (!registry.ok) return registry.hold
  if (foreignFacts(input.histories, intent, facts, identities))
    return held(input.uw, 'framing-binding-conflict', intent, null)
  const bindings: MemberBinding[] = facts.flatMap((record) =>
    record.payload.phase === 'member-binding' ? [{ ref: ref(record), payload: record.payload }] : [],
  )
  const member = memberKey(input.uw, intent, registry.value, bindings, identities)
  if (member === null) return held(input.uw, 'framing-binding-conflict', intent, null)
  const claimed = claimHold(input.uw, intent, registry.value, member, bindings)
  if (claimed !== null) return claimed
  const { result, resultPayload, claims, members } = registry.value
  if (result === null || resultPayload === null || claims.size !== members.size)
    return held(input.uw, 'framing-aggregate-incomplete', intent, member, [{ kind: 'result' }])
  return (
    resultHold({ ...input, intent, member, registry: registry.value }, resultPayload) ?? {
      status: 'complete',
      intent,
      result,
      member,
    }
  )
}

export function readFramingCoverageIntent(input: {
  uw: Scope
  histories: readonly DecodedHistory[]
  membership: Extract<FramingMembership, { status: 'complete' }>
}): UwResult<BoundFramingCoverageIntent | null> {
  const roots = input.histories.filter((history) => sameScope(history.source.scope, input.membership.intent.scope))
  if (roots.length !== 1)
    return {
      ok: false,
      diagnostics: [diagnostic(input.uw, 'framing-aggregate-unreadable', 'Intent history is missing or ambiguous')],
    }
  const registry = reconstructFramingRegistry(roots[0], input.membership.intent)
  if (!registry.ok) return registry
  if (
    registry.value.result === null ||
    registry.value.resultPayload === null ||
    !sameRef(registry.value.result, input.membership.result)
  )
    return conflict(input.uw, 'Result no longer matches membership')
  const matching = registry.value.resultPayload.coverage.filter((item) => sameScope(item.parent, input.uw))
  if (matching.length > 1 || matching.some((item) => !sameRef(item.aggregateIntent, input.membership.intent)))
    return conflict(input.uw, 'Coverage intent is duplicate or names a different aggregate')
  for (const ancestor of matching[0]?.ancestors ?? []) {
    if (ancestor.kind !== 'framing-member') continue
    const members = registry.value.resultPayload.members.filter(
      (member) => member.key === ancestor.member && sameScope(member.scope, ancestor.scope),
    )
    if (members.length !== 1) return conflict(input.uw, 'Coverage ancestor does not resolve uniquely in the result')
  }
  return {
    ok: true,
    value: matching.length === 0 ? null : { ...matching[0], aggregateResult: input.membership.result },
  }
}
