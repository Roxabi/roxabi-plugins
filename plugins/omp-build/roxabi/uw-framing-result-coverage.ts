import { acceptedMetadataOwner, canonicalValueDigest, framingAcceptedStateDigest } from '../dist/contracts.js'
import type { Scope } from '../engine/record-values.ts'
import type { UwResult } from '../engine/uw-diagnostics.ts'
import type { FramingProposal, FramingReceiptPayload, FramingReceiptRef } from '../engine/uw-framing-receipt-schema.ts'
import type { UwNativeNode } from '../engine/uw-graph.ts'
import type { ParentCoverage } from '../engine/workflow-mandate-schema.ts'
import type { UwRead } from './uw-contract.ts'

type ResultPayload = Extract<FramingReceiptPayload, { phase: 'result' }>
type ResultMember = ResultPayload['members'][number]
type ResultCoverage = ResultPayload['coverage'][number]
type Planned = FramingProposal['members'][number]
type CoverageIntent = FramingProposal['input']['coverage'][number]
type CompleteMember = ResultMember & {
  snapshot: NonNullable<ResultMember['snapshot']>
  tier: NonNullable<ResultMember['tier']>
}
type CoverageMaps = {
  results: ReadonlyMap<string, ResultMember>
  parents: ReadonlyMap<string, ParentCoverage>
  parentOf: ReadonlyMap<string, string>
}
export type FramingCoverageContext = {
  proposal: FramingProposal
  intent: FramingReceiptRef
  rootRead: UwRead
  reader: NonNullable<UwRead['observedReader']>
  nodes: readonly UwNativeNode[]
  histories: Extract<UwRead['observation'], { status: 'complete' }>['histories']
  fail: (code: string, message: string) => UwResult<never>
}
type ResultContext = FramingCoverageContext
function scopeOrder(left: Scope, right: Scope): number {
  const a = `${left.repository}\0${left.target}`
  const b = `${right.repository}\0${right.target}`
  return a < b ? -1 : a > b ? 1 : 0
}
function isCompleteMember(member: ResultMember | undefined): member is CompleteMember {
  return member !== undefined && member.snapshot !== null && member.tier !== null
}
function coverageAssignment(
  assignment: CoverageIntent['assignments'][number],
  allocation: NonNullable<Planned['allocation']>,
  results: ReadonlyMap<string, ResultMember>,
): ParentCoverage['assignments'][number] | null {
  const criterion = assignment.criterion
  const id =
    criterion.kind === 'existing'
      ? criterion.id
      : allocation.assignments.find((entry) => entry.draftKey === criterion.draftKey)?.id
  const children = assignment.children.map((key) => results.get(key)?.scope)
  if (!id?.startsWith('C') || children.length === 0 || children.some((scope) => scope === undefined)) return null
  return {
    criterion: id as ParentCoverage['assignments'][number]['criterion'],
    children: children as ParentCoverage['assignments'][number]['children'],
  }
}

function parentCoverage(
  ctx: ResultContext,
  item: CoverageIntent,
  results: ReadonlyMap<string, ResultMember>,
): UwResult<ParentCoverage> {
  const parent = results.get(item.parent)
  const allocation = ctx.proposal.members.find((entry) => entry.key === item.parent)?.allocation
  if (!parent?.snapshot || !allocation)
    return ctx.fail('framing-coverage-invalid', 'Coverage parent has no approved UW Spec')
  const assignments: ParentCoverage['assignments'] = []
  for (const assignment of item.assignments) {
    const resolved = coverageAssignment(assignment, allocation, results)
    if (resolved === null) return ctx.fail('framing-coverage-invalid', 'Coverage cannot resolve a criterion or child')
    assignments.push(resolved)
  }
  return { ok: true, value: { parent: { uw: parent.scope, version: parent.snapshot.spec.version }, assignments } }
}

/** Planned children of one member in scope order, or null when any has no confirmed Spec and tier. */
function completeChildren(
  proposal: FramingProposal,
  parent: string,
  results: ReadonlyMap<string, ResultMember>,
): CompleteMember[] | null {
  const children = proposal.input.edges.flatMap((edge) =>
    edge.kind === 'parent-child' && edge.parent === parent ? [results.get(edge.child)] : [],
  )
  const complete = children.filter(isCompleteMember)
  return complete.length === children.length ? complete.sort((a, b) => scopeOrder(a.scope, b.scope)) : null
}

function plannedAncestors(
  ctx: ResultContext,
  parent: string,
  maps: CoverageMaps,
): UwResult<ResultCoverage['ancestors']> {
  const ancestors: ResultCoverage['ancestors'] = []
  for (let key = maps.parentOf.get(parent); key !== undefined; key = maps.parentOf.get(key)) {
    const ancestor = maps.results.get(key)
    if (!isCompleteMember(ancestor)) return ctx.fail('framing-coverage-invalid', 'Planned ancestor is unavailable')
    const children = completeChildren(ctx.proposal, key, maps.results)
    if (children === null) return ctx.fail('framing-coverage-invalid', 'Planned ancestor children are unavailable')
    ancestors.push({
      kind: 'framing-member',
      member: key,
      scope: ancestor.scope,
      specVersion: ancestor.snapshot.spec.version,
      tier: ancestor.tier,
      acceptedStateDigest: framingAcceptedStateDigest({
        spec: ancestor.snapshot.spec,
        tier: ancestor.tier,
        children: children.map((child) => ({
          scope: child.scope,
          specVersion: child.snapshot.spec.version,
          snapshot: child.snapshot,
          tier: child.tier,
        })),
        coverage: maps.parents.get(key) ?? null,
      }),
    })
  }
  return { ok: true, value: ancestors }
}

/** External accepted ancestors must still match the sealed inherited vector in the same cut. */
async function acceptedAncestors(ctx: ResultContext, planned: Planned): Promise<UwResult<ResultCoverage['ancestors']>> {
  const ancestors: ResultCoverage['ancestors'] = []
  for (const own of planned.inherited) {
    const read = await ctx.reader.readUw(own.uw)
    if (
      read.observation !== ctx.rootRead.observation ||
      read.accepted.status !== 'accepted' ||
      canonicalValueDigest(read.accepted.value.ref) !== canonicalValueDigest(own)
    )
      return ctx.fail('framing-ancestry-changed', 'An external accepted ancestor no longer matches the sealed vector')
    const step = read.accepted.value.chain.at(-1)
    if (!step) return ctx.fail('framing-ancestry-changed', 'Accepted ancestor metadata is unavailable')
    const metadata = acceptedMetadataOwner(step, ctx.histories)
    if (!metadata.ok) return ctx.fail('framing-ancestry-changed', 'Accepted ancestor metadata cannot be authenticated')
    ancestors.push({ kind: 'accepted', own, metadata: metadata.value.record })
  }
  return { ok: true, value: ancestors }
}

async function coverageEntry(
  ctx: ResultContext,
  item: CoverageIntent,
  maps: CoverageMaps,
): Promise<UwResult<ResultCoverage>> {
  const parent = maps.results.get(item.parent)
  const planned = ctx.proposal.members.find((entry) => entry.key === item.parent)
  const coverage = maps.parents.get(item.parent)
  if (!isCompleteMember(parent) || !planned || !coverage)
    return ctx.fail('framing-coverage-invalid', 'Coverage parent is not a UW')
  const children = completeChildren(ctx.proposal, item.parent, maps.results)
  if (children === null) return ctx.fail('framing-coverage-invalid', 'A child Spec or tier is unavailable')
  const ancestors = plannedAncestors(ctx, item.parent, maps)
  if (!ancestors.ok) return ancestors
  const accepted = await acceptedAncestors(ctx, planned)
  if (!accepted.ok) return accepted
  return {
    ok: true,
    value: {
      parent: parent.scope,
      parentVersion: parent.snapshot.spec.version,
      criteria: parent.snapshot.spec.criteria.map(({ id, statement }) => ({ id, statement })),
      children: children.map((child) => ({
        scope: child.scope,
        specVersion: child.snapshot.spec.version,
        tier: child.tier,
        criteria: child.snapshot.spec.criteria.map(({ id, statement }) => ({ id, statement })),
      })),
      coverage,
      ancestors: [...ancestors.value, ...accepted.value],
      aggregateIntent: ctx.intent,
    },
  }
}

export async function buildFramingResultCoverage(
  ctx: ResultContext,
  results: ReadonlyMap<string, ResultMember>,
): Promise<UwResult<ResultCoverage[]>> {
  const parentOf = new Map<string, string>()
  for (const edge of ctx.proposal.input.edges) if (edge.kind === 'parent-child') parentOf.set(edge.child, edge.parent)
  const parents = new Map<string, ParentCoverage>()
  for (const item of ctx.proposal.input.coverage) {
    const parent = parentCoverage(ctx, item, results)
    if (!parent.ok) return parent
    parents.set(item.parent, parent.value)
  }
  const coverage: ResultCoverage[] = []
  for (const item of ctx.proposal.input.coverage) {
    const entry = await coverageEntry(ctx, item, { results, parents, parentOf })
    if (!entry.ok) return entry
    coverage.push(entry.value)
  }
  return { ok: true, value: coverage }
}
