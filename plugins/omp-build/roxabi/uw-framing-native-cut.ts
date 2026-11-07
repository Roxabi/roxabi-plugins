import { cycleKeys, relationGraph, sameScope, scopeKey } from '../dist/contracts.js'
import type { Scope } from '../engine/record-values.ts'
import type { UwDiagnostic, UwResult } from '../engine/uw-diagnostics.ts'
import type { FramingAggregateInput, FramingMemberKey } from '../engine/uw-framing-schema.ts'
import type { UwRead } from './uw-contract.ts'
import { observeFramingStepZero } from './uw-framing-step-zero.ts'

type AggregateMember = FramingAggregateInput['members'][number]
type AggregateEdge = FramingAggregateInput['edges'][number]
function diagnostic(uw: Scope, code: string, message: string): UwDiagnostic {
  return { code, message, location: { kind: 'native', uw, connection: 'state' }, related: [] }
}
function repositoryDiagnostic(repository: string, code: string, message: string): UwDiagnostic {
  return { code, message, location: { kind: 'repository', repository }, related: [] }
}
function aggregateRepository(aggregate: FramingAggregateInput): string {
  return aggregate.source.kind === 'free-text' ? aggregate.source.repository : aggregate.source.uw.repository
}
function edgeEnds(edge: AggregateEdge): [FramingMemberKey, FramingMemberKey] {
  return edge.kind === 'parent-child' ? [edge.parent, edge.child] : [edge.dependent, edge.blocker]
}

/** A planned child that already has a native parent keeps exactly that parent. */
function foreignParent(
  edge: AggregateEdge,
  source: AggregateMember,
  destination: AggregateMember,
  reads: ReadonlyMap<string, UwRead>,
): UwDiagnostic[] {
  if (edge.kind !== 'parent-child' || destination.slot.kind !== 'existing') return []
  const child = destination.slot.uw
  const parent = reads.get(edge.child)?.graph.nodes.find((item) => sameScope(item.uw, child))?.parent ?? null
  if (parent === null) return []
  if (source.slot.kind === 'existing' && sameScope(parent, source.slot.uw)) return []
  return [diagnostic(child, 'framing-foreign-parent', 'A planned child cannot be reparented')]
}

/** Add planned UW-to-UW relations to the observed graph, keyed by native scope or planned slot. */
function addPlannedEdges(
  aggregate: FramingAggregateInput,
  reads: ReadonlyMap<string, UwRead>,
  edges: Map<string, string[]>,
): UwDiagnostic[] {
  const members = new Map(aggregate.members.map((member) => [member.slot.key, member]))
  const keyFor = (key: string): string => {
    const member = members.get(key)
    return member?.slot.kind === 'existing' ? scopeKey(member.slot.uw) : `\u0000new\u0000${key}`
  }
  const diagnostics: UwDiagnostic[] = []
  for (const edge of aggregate.edges) {
    const [from, to] = edgeEnds(edge)
    const source = members.get(from)
    const destination = members.get(to)
    if (source?.kind !== 'uw' || destination?.kind !== 'uw' || from === to) continue
    diagnostics.push(...foreignParent(edge, source, destination, reads))
    const key = keyFor(from)
    const next = keyFor(to)
    const outgoing = edges.get(key) ?? []
    if (!outgoing.includes(next)) outgoing.push(next)
    edges.set(key, outgoing)
  }
  return diagnostics
}

function cycleDiagnostic(aggregate: FramingAggregateInput): UwDiagnostic {
  const existing = aggregate.members.find((member) => member.slot.kind === 'existing')
  if (existing?.slot.kind === 'existing')
    return diagnostic(existing.slot.uw, 'framing-graph-cycle', 'Observed and planned relations form a combined cycle')
  return repositoryDiagnostic(
    aggregateRepository(aggregate),
    'framing-graph-cycle',
    'Planned relations form a combined cycle',
  )
}

/** Check Step 0 and the combined observed/planned hierarchy before any confirmation or effect. */
export function validateFramingNativeCut(input: {
  aggregate: FramingAggregateInput
  reads: ReadonlyMap<string, UwRead>
}): UwResult<true> {
  const { aggregate, reads } = input
  const { diagnostics, observed } = observeFramingStepZero(aggregate, reads)
  const graph = relationGraph([...observed.values()])
  diagnostics.push(...graph.diagnostics)
  const edges = new Map([...graph.edges].map(([key, values]) => [key, [...values]]))
  diagnostics.push(...addPlannedEdges(aggregate, reads, edges))
  if (cycleKeys(edges).length > 0) diagnostics.push(cycleDiagnostic(aggregate))
  return diagnostics.length > 0 ? { ok: false, diagnostics } : { ok: true, value: true }
}
