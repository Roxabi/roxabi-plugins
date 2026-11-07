import type { DecodedHistory } from './history-schema.ts'
import { sameRef } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Scope } from './record-values.ts'
import { validateFramingAuthorization } from './uw-framing-authorization.ts'
import {
  drift,
  type FramingMembership,
  type FramingMissingFact,
  held,
  type MembershipContext,
} from './uw-framing-hold.ts'
import type { FramingRegistry } from './uw-framing-registry.ts'
import type { FramingMemberKey } from './uw-framing-schema.ts'
import { isWayfinder, sameScope, type UwNativeNode } from './uw-graph.ts'
import type { SpecIdentityPayload } from './uw-identity-schema.ts'

type Receipt = Extract<CanonicalRecord, { kind: 'framing-receipt' }>
type Intent = Extract<Receipt['payload'], { phase: 'intent' }>
type ResultPayload = Extract<Receipt['payload'], { phase: 'result' }>
type FramingIdentity = Extract<SpecIdentityPayload, { format: 'omp-build-spec-identity/2' }>
type ExpectedIdentity = { member: FramingMemberKey; event: 'allocate' | 'retire-proposed' }
function expectedIdentities(registry: FramingRegistry): ExpectedIdentity[] {
  return registry.proposal.members.flatMap((item) =>
    item.allocation === null
      ? []
      : [
          ...(item.allocation.assignments.length > 0 ? [{ member: item.key, event: 'allocate' as const }] : []),
          ...(item.allocation.retirements.length > 0 ? [{ member: item.key, event: 'retire-proposed' as const }] : []),
        ],
  )
}
function framingIdentity(
  op: DecodedHistory['operations'][number],
  expected: ExpectedIdentity,
): { recordId: string; payload: FramingIdentity } | null {
  const record = op.record
  if (op.authority === 'foreign' || op.status !== 'complete' || record?.kind !== 'spec-identity') return null
  const payload = record.payload
  if (
    payload.format !== 'omp-build-spec-identity/2' ||
    payload.event !== expected.event ||
    payload.aggregate.member !== expected.member
  )
    return null
  return { recordId: record.recordId, payload }
}
function recordedIdentities(
  history: DecodedHistory,
  expected: ExpectedIdentity,
  payload: ResultPayload,
): FramingIdentity[] {
  return history.operations.flatMap((op) => {
    const identity = framingIdentity(op, expected)
    if (identity === null) return []
    const reference = { scope: history.source.scope, recordId: identity.recordId, kind: 'spec-identity' as const }
    return payload.identities.some((item) => sameRef(item, reference)) ? [identity.payload] : []
  })
}
function expectedIdentityHold(
  ctx: MembershipContext,
  payload: ResultPayload,
  expected: ExpectedIdentity,
): FramingMembership | null {
  const missing: FramingMissingFact[] = [{ kind: 'identity', member: expected.member }]
  const memberClaim = ctx.registry.claims.get(expected.member)
  if (!memberClaim) return held(ctx.uw, 'framing-aggregate-incomplete', ctx.intent, ctx.member, missing)
  const histories = ctx.histories.filter((history) => sameScope(history.source.scope, memberClaim.scope))
  const history = histories[0]
  if (histories.length !== 1 || !history.source.complete)
    return held(ctx.uw, 'framing-aggregate-unreadable', ctx.intent, ctx.member, missing)
  const identities = recordedIdentities(history, expected, payload)
  const identity = identities[0]
  const authorized =
    identities.length === 1 &&
    identity !== undefined &&
    validateFramingAuthorization({
      uw: memberClaim.scope,
      histories: ctx.histories,
      authorization: identity.aggregate,
      payload: identity,
    }).ok
  return authorized ? null : held(ctx.uw, 'framing-binding-conflict', ctx.intent, ctx.member, missing)
}
function identityHold(ctx: MembershipContext, payload: ResultPayload): FramingMembership | null {
  const expected = expectedIdentities(ctx.registry)
  if (payload.identities.length !== expected.length)
    return held(ctx.uw, 'framing-aggregate-incomplete', ctx.intent, ctx.member, [
      { kind: 'identity', member: ctx.member },
    ])
  for (const item of expected) {
    const hold = expectedIdentityHold(ctx, payload, item)
    if (hold !== null) return hold
  }
  return null
}
function nodeKindMatches(
  node: UwNativeNode,
  recorded: ResultPayload['members'][number],
  memberInput: Intent['proposal']['input']['members'][number],
): boolean {
  if (memberInput.kind === 'uw') {
    const tiers = node.labels.filter((label) => label.startsWith('size:'))
    return (
      recorded.snapshot !== null &&
      node.raw.bodySha256 === recorded.snapshot.raw.bodySha256 &&
      tiers.length === 1 &&
      tiers[0] === `size:${recorded.tier}` &&
      !isWayfinder(node)
    )
  }
  return (
    isWayfinder(node) &&
    node.labels.includes(memberInput.label) &&
    !node.labels.some((label) => label.startsWith('size:')) &&
    node.raw.body === memberInput.body
  )
}
function nativeEdgePresent(node: UwNativeNode, uw: Scope, edge: ResultPayload['edges'][number]): boolean {
  if (edge.kind === 'blocker')
    return !sameScope(edge.dependent, uw) || node.blockers.some((blocker) => sameScope(blocker, edge.blocker))
  if (sameScope(edge.parent, uw)) return node.children.some((child) => sameScope(child, edge.child))
  return !sameScope(edge.child, uw) || (node.parent !== null && sameScope(node.parent, edge.parent))
}
/** Before acceptance, the native issue itself must still carry the recorded title, Spec or label, tier and edges. */
function nativeHold(ctx: MembershipContext, payload: ResultPayload): FramingMembership | null {
  if (ctx.accepted.status !== 'absent') return null
  const node =
    ctx.graph.status === 'complete' ? ctx.graph.nodes.find((entry) => sameScope(entry.uw, ctx.uw)) : undefined
  const recorded = payload.members.find((entry) => entry.key === ctx.member)
  const memberInput = ctx.registry.proposal.input.members.find((entry) => entry.slot.key === ctx.member)
  if (!node || !recorded || !memberInput || node.title !== memberInput.title) return drift(ctx)
  if (!nodeKindMatches(node, recorded, memberInput)) return drift(ctx)
  return payload.edges.every((edge) => nativeEdgePresent(node, ctx.uw, edge)) ? null : drift(ctx)
}
export function resultCurrentHold(ctx: MembershipContext, payload: ResultPayload): FramingMembership | null {
  return identityHold(ctx, payload) ?? nativeHold(ctx, payload)
}
