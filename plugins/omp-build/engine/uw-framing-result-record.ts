import { canonicalValueDigest } from './canonical-value.ts'
import { sameRef } from './record-diagnostics.ts'
import { specDigest } from './record-digests.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Scope } from './record-values.ts'
import { drift, type FramingMembership, held, type MembershipContext } from './uw-framing-hold.ts'
import type { FramingReceiptRef } from './uw-framing-receipt-schema.ts'
import type { RegistryClaim } from './uw-framing-registry.ts'
import type { FramingEdge, FramingMemberKey } from './uw-framing-schema.ts'
import { sameScope } from './uw-graph.ts'

type Receipt = Extract<CanonicalRecord, { kind: 'framing-receipt' }>
type Intent = Extract<Receipt['payload'], { phase: 'intent' }>
type ResultPayload = Extract<Receipt['payload'], { phase: 'result' }>
type PlannedMember = Intent['proposal']['members'][number]
function recordedClaimMatches(
  item: RegistryClaim | undefined,
  payload: ResultPayload,
  index: number,
  planned: PlannedMember,
): boolean {
  const recorded = payload.members[index]
  return (
    item !== undefined &&
    sameRef(item.claim, payload.claims[index]) &&
    sameRef(item.binding, payload.bindings[index]) &&
    sameScope(item.scope, recorded.scope) &&
    recorded.key === planned.key &&
    recorded.memberDigest === planned.memberDigest &&
    sameRef(item.binding, recorded.binding)
  )
}
function orderHold(ctx: MembershipContext, payload: ResultPayload): FramingMembership | null {
  const planned = ctx.registry.proposal.members
  const aligned =
    payload.claims.length === planned.length &&
    payload.bindings.length === planned.length &&
    payload.members.length === planned.length &&
    planned.every((item, index) => recordedClaimMatches(ctx.registry.claims.get(item.key), payload, index, item))
  if (!aligned) return held(ctx.uw, 'framing-binding-conflict', ctx.intent, ctx.member)
  if (
    payload.graphDigest !== canonicalValueDigest(payload.edges) ||
    payload.identityDigest !== canonicalValueDigest(payload.identities)
  )
    return drift(ctx)
  return null
}
function allocationMatches(planned: PlannedMember, actual: ResultPayload['members'][number]): boolean {
  const allocation = planned.allocation
  if (allocation === null) return actual.snapshot === null && actual.tier === null
  return (
    actual.snapshot !== null &&
    actual.tier === planned.tier &&
    canonicalValueDigest(actual.snapshot.spec) === canonicalValueDigest(allocation.spec) &&
    specDigest(actual.snapshot.raw.body) === actual.snapshot.raw.bodySha256
  )
}
function allocationHold(ctx: MembershipContext, payload: ResultPayload): FramingMembership | null {
  const planned = ctx.registry.proposal.members
  return planned.every((item, index) => allocationMatches(item, payload.members[index])) ? null : drift(ctx)
}
function sameRecordedEdge(
  edge: FramingEdge,
  recorded: ResultPayload['edges'][number],
  from: Scope,
  to: Scope,
): boolean {
  if (edge.kind === 'parent-child')
    return recorded.kind === 'parent-child' && sameScope(recorded.parent, from) && sameScope(recorded.child, to)
  return recorded.kind === 'blocker' && sameScope(recorded.dependent, from) && sameScope(recorded.blocker, to)
}
function edgeHold(ctx: MembershipContext, payload: ResultPayload): FramingMembership | null {
  const scopeOf = (key: FramingMemberKey) => ctx.registry.claims.get(key)?.scope
  for (const edge of ctx.registry.proposal.input.edges) {
    const from = scopeOf(edge.kind === 'parent-child' ? edge.parent : edge.dependent)
    const to = scopeOf(edge.kind === 'parent-child' ? edge.child : edge.blocker)
    const recorded = from && to ? payload.edges.filter((item) => sameRecordedEdge(edge, item, from, to)).length : 0
    if (recorded !== 1) return drift(ctx, [{ kind: 'edge', edge }])
  }
  return null
}
type ResultCoverage = ResultPayload['coverage'][number]
type ResultSnapshot = NonNullable<ResultPayload['members'][number]['snapshot']>
function coverageHeaderMatches(
  coverage: ResultCoverage,
  intent: FramingReceiptRef,
  parent: Scope,
  snapshot: ResultSnapshot,
): boolean {
  return (
    sameRef(coverage.aggregateIntent, intent) &&
    coverage.parentVersion === snapshot.spec.version &&
    canonicalValueDigest(coverage.criteria) === canonicalValueDigest(snapshot.spec.criteria) &&
    sameScope(coverage.coverage.parent.uw, parent) &&
    coverage.coverage.parent.version === snapshot.spec.version
  )
}
function coverageChildrenMatch(
  ctx: MembershipContext,
  payload: ResultPayload,
  parent: FramingMemberKey,
  coverage: ResultCoverage,
): boolean {
  const expected = ctx.registry.proposal.input.edges.flatMap((edge) =>
    edge.kind === 'parent-child' && edge.parent === parent
      ? [payload.members.find((item) => item.key === edge.child)]
      : [],
  )
  const complete = expected.flatMap((child) =>
    child?.snapshot && child.tier ? [{ scope: child.scope, snapshot: child.snapshot, tier: child.tier }] : [],
  )
  if (complete.length !== expected.length || coverage.children.length !== expected.length) return false
  return coverage.children.every((child) =>
    complete.some(
      (item) =>
        sameScope(child.scope, item.scope) &&
        child.specVersion === item.snapshot.spec.version &&
        child.tier === item.tier &&
        canonicalValueDigest(child.criteria) === canonicalValueDigest(item.snapshot.spec.criteria),
    ),
  )
}
function coverageMatches(
  ctx: MembershipContext,
  payload: ResultPayload,
  planned: Intent['proposal']['input']['coverage'][number],
): boolean {
  const allocation = ctx.registry.proposal.members.find((item) => item.key === planned.parent)?.allocation
  const resultMember = payload.members.find((item) => item.key === planned.parent)
  const snapshot = resultMember?.snapshot
  if (!allocation || !resultMember || !snapshot) return false
  const matches = payload.coverage.filter((item) => sameScope(item.parent, resultMember.scope))
  const coverage = matches[0]
  if (
    matches.length !== 1 ||
    coverage === undefined ||
    !coverageHeaderMatches(coverage, ctx.intent, resultMember.scope, snapshot)
  )
    return false
  const expectedAssignments = planned.assignments.map((assignment) => {
    const criterion = assignment.criterion
    return {
      criterion:
        criterion.kind === 'existing'
          ? criterion.id
          : allocation.assignments.find((entry) => entry.draftKey === criterion.draftKey)?.id,
      children: assignment.children.map((key) => ctx.registry.claims.get(key)?.scope),
    }
  })
  if (canonicalValueDigest(coverage.coverage.assignments) !== canonicalValueDigest(expectedAssignments)) return false
  return coverageChildrenMatch(ctx, payload, planned.parent, coverage)
}
function coverageHold(ctx: MembershipContext, payload: ResultPayload): FramingMembership | null {
  const planned = ctx.registry.proposal.input.coverage
  if (payload.coverage.length !== planned.length) return drift(ctx)
  return planned.every((item) => coverageMatches(ctx, payload, item)) ? null : drift(ctx)
}
export function resultRecordHold(ctx: MembershipContext, payload: ResultPayload): FramingMembership | null {
  return orderHold(ctx, payload) ?? allocationHold(ctx, payload) ?? edgeHold(ctx, payload) ?? coverageHold(ctx, payload)
}
