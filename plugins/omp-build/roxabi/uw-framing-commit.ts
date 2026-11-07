import { canonicalValueDigest, isWayfinder, sameScope, scopeKey } from '../dist/contracts.js'
import type { ExternalRecordRef } from '../engine/record-references.ts'
import type { Scope } from '../engine/record-values.ts'
import type { UwDiagnostic, UwResult } from '../engine/uw-diagnostics.ts'
import type { FramingProposal, FramingReceiptPayload, FramingReceiptRef } from '../engine/uw-framing-receipt-schema.ts'
import type { FramingMemberKey } from '../engine/uw-framing-schema.ts'
import type { UwNativeNode } from '../engine/uw-graph.ts'
import type { UwRead } from './uw-contract.ts'
import { buildFramingResultCoverage, type FramingCoverageContext } from './uw-framing-result-coverage.ts'

type ResultPayload = Extract<FramingReceiptPayload, { phase: 'result' }>
type ResultMember = ResultPayload['members'][number]
type BoundMember = { key: FramingMemberKey; scope: Scope; claim: FramingReceiptRef; binding: FramingReceiptRef }

function diagnostic(uw: Scope, code: string, message: string): UwDiagnostic {
  return { code, message, location: { kind: 'native', uw, connection: 'state' }, related: [] }
}

type ResultEdge = ResultPayload['edges'][number]
type Planned = FramingProposal['members'][number]
type Confirmed = { planned: Planned; bound: BoundMember; result: ResultMember }
type ResultContext = FramingCoverageContext

function nodeOf(nodes: readonly UwNativeNode[], scope: Scope): UwNativeNode | undefined {
  return nodes.find((entry) => sameScope(entry.uw, scope))
}

/** A member's confirmed Spec and tier, or tierless Wayfinder state, from the same final cut. */
function memberResult(ctx: ResultContext, planned: Planned, bound: BoundMember, read: UwRead): UwResult<ResultMember> {
  const base = { key: planned.key, scope: bound.scope, memberDigest: planned.memberDigest, binding: bound.binding }
  const node = nodeOf(ctx.nodes, bound.scope)
  if (planned.allocation === null) {
    if (!node || !isWayfinder(node) || node.labels.some((label) => label.startsWith('size:')))
      return ctx.fail('framing-wayfinder-unconfirmed', 'Wayfinder classification or tierless state is unconfirmed')
    return { ok: true, value: { ...base, snapshot: null, tier: null } }
  }
  if (
    read.parsed.status !== 'conformant' ||
    canonicalValueDigest(read.parsed.snapshot.spec) !== canonicalValueDigest(planned.allocation.spec)
  )
    return ctx.fail('framing-result-drift', 'A member Spec differs from the approved allocation')
  const tiers = node?.labels.filter((label) => label.startsWith('size:')) ?? []
  if (!node || isWayfinder(node) || planned.tier === null || tiers.length !== 1 || tiers[0] !== `size:${planned.tier}`)
    return ctx.fail('framing-result-drift', 'A member tier differs from the approved tier')
  return { ok: true, value: { ...base, snapshot: read.parsed.snapshot, tier: planned.tier } }
}

async function confirmedMembers(ctx: ResultContext, members: readonly BoundMember[]): Promise<UwResult<Confirmed[]>> {
  const byKey = new Map(members.map((member) => [member.key, member]))
  if (byKey.size !== ctx.proposal.members.length || members.length !== ctx.proposal.members.length)
    return ctx.fail('framing-binding-conflict', 'Every sealed member must have one confirmed binding and claim')
  const confirmed: Confirmed[] = []
  for (const planned of ctx.proposal.members) {
    const bound = byKey.get(planned.key)
    if (!bound) return ctx.fail('framing-binding-conflict', 'A sealed member is missing')
    const read = sameScope(bound.scope, ctx.rootRead.uw) ? ctx.rootRead : await ctx.reader.readUw(bound.scope)
    if (read.observation !== ctx.rootRead.observation || read.graph.status !== 'complete')
      return ctx.fail('framing-result-unreadable', 'Members must be read from the exact same complete observation')
    const result = memberResult(ctx, planned, bound, read)
    if (!result.ok) return result
    confirmed.push({ planned, bound, result: result.value })
  }
  return { ok: true, value: confirmed }
}

function edgeKey(edge: ResultEdge): string {
  return edge.kind === 'parent-child'
    ? `p:${scopeKey(edge.parent)}:${scopeKey(edge.child)}`
    : `b:${scopeKey(edge.dependent)}:${scopeKey(edge.blocker)}`
}

/** Native UW children and blockers of one UW member; observed edges keep their observed origin. */
function memberEdges(nodes: readonly UwNativeNode[], planned: Planned, scope: Scope, node: UwNativeNode): ResultEdge[] {
  const uwOnly = (target: Scope) => {
    const found = nodeOf(nodes, target)
    return found !== undefined && !isWayfinder(found)
  }
  const observed = planned.slot.kind === 'existing' ? planned.slot.observed : null
  const children = node.children.filter(uwOnly).map(
    (child): ResultEdge => ({
      kind: 'parent-child',
      parent: scope,
      child,
      origin: observed?.children.some((item) => sameScope(item, child)) ? 'observed' : 'written',
    }),
  )
  const blockers = node.blockers.filter(uwOnly).map(
    (blocker): ResultEdge => ({
      kind: 'blocker',
      dependent: scope,
      blocker,
      origin: observed?.blockers.some((item) => sameScope(item, blocker)) ? 'observed' : 'written',
    }),
  )
  return [...children, ...blockers]
}

function observedEdges(ctx: ResultContext, confirmed: readonly Confirmed[]): ResultEdge[] {
  const edges = new Map<string, ResultEdge>()
  for (const { planned, bound } of confirmed) {
    const node = nodeOf(ctx.nodes, bound.scope)
    if (!node || planned.allocation === null) continue
    for (const edge of memberEdges(ctx.nodes, planned, bound.scope, node))
      if (!edges.has(edgeKey(edge))) edges.set(edgeKey(edge), edge)
  }
  return [...edges.values()]
}

function sameResultEdge(kind: ResultEdge['kind'], item: ResultEdge, from: Scope, to: Scope): boolean {
  if (kind === 'parent-child')
    return item.kind === 'parent-child' && sameScope(item.parent, from) && sameScope(item.child, to)
  return item.kind === 'blocker' && sameScope(item.dependent, from) && sameScope(item.blocker, to)
}

function plannedEdgeMissing(
  proposal: FramingProposal,
  byKey: ReadonlyMap<string, BoundMember>,
  edges: readonly ResultEdge[],
): boolean {
  return proposal.input.edges.some((edge) => {
    const from = byKey.get(edge.kind === 'parent-child' ? edge.parent : edge.dependent)
    const to = byKey.get(edge.kind === 'parent-child' ? edge.child : edge.blocker)
    return !from || !to || !edges.some((item) => sameResultEdge(edge.kind, item, from.scope, to.scope))
  })
}

/** Construct a result only from the real complete post-effect graph and member reads. */
export async function buildFramingResultPayload(input: {
  proposal: FramingProposal
  intent: FramingReceiptRef
  members: readonly BoundMember[]
  identities: readonly ExternalRecordRef[]
  rootRead: UwRead
}): Promise<UwResult<ResultPayload>> {
  const { proposal, intent, rootRead } = input
  const fail = (code: string, message: string): UwResult<never> => ({
    ok: false,
    diagnostics: [diagnostic(rootRead.uw, code, message)],
  })
  const reader = rootRead.observedReader
  if (rootRead.observation.status !== 'complete' || rootRead.graph.status !== 'complete' || reader === undefined)
    return fail(
      'framing-result-unreadable',
      'A complete post-effect observation and same-cut member reader are required',
    )
  const ctx: ResultContext = {
    proposal,
    intent,
    rootRead,
    reader,
    nodes: rootRead.graph.nodes,
    histories: rootRead.observation.histories,
    fail,
  }
  const confirmed = await confirmedMembers(ctx, input.members)
  if (!confirmed.ok) return confirmed
  const results = confirmed.value.map((item) => item.result)
  const edges = observedEdges(ctx, confirmed.value)
  if (plannedEdgeMissing(proposal, new Map(confirmed.value.map((item) => [item.planned.key, item.bound])), edges))
    return fail('framing-edge-unconfirmed', 'A planned relation is not present in the complete final graph')
  const coverage = await buildFramingResultCoverage(ctx, new Map(results.map((member) => [member.key, member])))
  if (!coverage.ok) return coverage
  return {
    ok: true,
    value: {
      format: 'omp-build-framing-receipt/1',
      phase: 'result',
      intent,
      claims: confirmed.value.map((item) => item.bound.claim),
      bindings: confirmed.value.map((item) => item.bound.binding),
      identities: [...input.identities],
      members: results,
      edges,
      coverage: coverage.value,
      graphDigest: canonicalValueDigest(edges),
      identityDigest: canonicalValueDigest(input.identities),
    },
  }
}
