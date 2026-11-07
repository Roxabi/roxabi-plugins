import { canonicalValueDigest } from '../dist/contracts.js'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { FramingAggregateInput } from '../engine/uw-framing-schema.ts'

type AggregateMember = FramingAggregateInput['members'][number]
type UwMember = Extract<AggregateMember, { kind: 'uw' }>
function aggregateRepository(aggregate: FramingAggregateInput): string {
  return aggregate.source.kind === 'free-text' ? aggregate.source.repository : aggregate.source.uw.repository
}
function repositoryDiagnostic(repository: string, code: string, message: string): UwDiagnostic {
  return { code, message, location: { kind: 'repository', repository }, related: [] }
}
type Fail = (code: string, message: string) => UwDiagnostic

function slotRepository(member: AggregateMember): string {
  return member.slot.kind === 'existing' ? member.slot.uw.repository : member.slot.repository
}

/** Unique edges, same-repository parents, and at most one planned parent per child. */
function edgeTopology(
  input: FramingAggregateInput,
  members: ReadonlyMap<string, AggregateMember>,
  fail: Fail,
): { diagnostics: UwDiagnostic[]; parents: Map<string, string> } {
  const diagnostics: UwDiagnostic[] = []
  const parents = new Map<string, string>()
  const seenEdges = new Set<string>()
  for (const edge of input.edges) {
    const key = canonicalValueDigest(edge)
    if (seenEdges.has(key)) diagnostics.push(fail('framing-edge-duplicate', 'A planned edge is duplicated'))
    seenEdges.add(key)
    if (edge.kind !== 'parent-child') continue
    const parent = members.get(edge.parent)
    const child = members.get(edge.child)
    if (parent && child && slotRepository(parent) !== slotRepository(child))
      diagnostics.push(fail('cross-repository-parent', 'A planned parent and child must share a repository'))
    const previous = parents.get(edge.child)
    if (previous !== undefined && previous !== edge.parent)
      diagnostics.push(fail('framing-multiple-parents', 'A member cannot have multiple planned parents'))
    parents.set(edge.child, edge.parent)
  }
  return { diagnostics, parents }
}

/** Each parent criterion is assigned once, to actual immediate children, and every child is covered. */
function coverageEntryDiagnostics(
  coverage: FramingAggregateInput['coverage'][number],
  parent: UwMember,
  children: readonly string[],
  fail: Fail,
): UwDiagnostic[] {
  const criterionKeys = new Set(
    parent.draft.criteria.map((item) => (item.kind === 'existing' ? `existing:${item.id}` : `new:${item.draftKey}`)),
  )
  const diagnostics: UwDiagnostic[] = []
  const assigned = new Set<string>()
  const coveredChildren = new Set<string>()
  for (const assignment of coverage.assignments) {
    const key =
      assignment.criterion.kind === 'existing'
        ? `existing:${assignment.criterion.id}`
        : `new:${assignment.criterion.draftKey}`
    if (
      !criterionKeys.has(key) ||
      assigned.has(key) ||
      new Set(assignment.children).size !== assignment.children.length ||
      assignment.children.some((child) => !children.includes(child))
    )
      diagnostics.push(
        fail(
          'framing-coverage-invalid',
          'Coverage must assign each parent criterion once to actual immediate children',
        ),
      )
    assigned.add(key)
    for (const child of assignment.children) coveredChildren.add(child)
  }
  if (assigned.size !== criterionKeys.size || children.some((child) => !coveredChildren.has(child)))
    diagnostics.push(
      fail('framing-coverage-incomplete', 'Coverage must include every parent criterion and planned child'),
    )
  return diagnostics
}

function coverageTopology(
  input: FramingAggregateInput,
  members: ReadonlyMap<string, AggregateMember>,
  fail: Fail,
): UwDiagnostic[] {
  const diagnostics: UwDiagnostic[] = []
  const coveredParents = new Set<string>()
  for (const coverage of input.coverage) {
    const parent = members.get(coverage.parent)
    const children = input.edges.flatMap((edge) =>
      edge.kind === 'parent-child' && edge.parent === coverage.parent ? [edge.child] : [],
    )
    if (parent?.kind !== 'uw' || coveredParents.has(coverage.parent) || children.length === 0) {
      diagnostics.push(fail('framing-coverage-invalid', 'Coverage requires one UW parent and its planned children'))
      continue
    }
    coveredParents.add(coverage.parent)
    diagnostics.push(...coverageEntryDiagnostics(coverage, parent, children, fail))
  }
  for (const parent of new Set(input.edges.flatMap((edge) => (edge.kind === 'parent-child' ? [edge.parent] : []))))
    if (!coveredParents.has(parent))
      diagnostics.push(fail('framing-coverage-incomplete', 'Every parent requires complete coverage'))
  return diagnostics
}

function foundationUnblocked(
  input: FramingAggregateInput,
  foundation: FramingAggregateInput['foundations'][number],
): boolean {
  const siblings = input.edges.flatMap((edge) =>
    edge.kind === 'parent-child' && edge.parent === foundation.parent && edge.child !== foundation.child
      ? [edge.child]
      : [],
  )
  return siblings.some(
    (sibling) =>
      !input.edges.some(
        (edge) => edge.kind === 'blocker' && edge.dependent === sibling && edge.blocker === foundation.child,
      ),
  )
}

function foundationTopology(
  input: FramingAggregateInput,
  parents: ReadonlyMap<string, string>,
  fail: Fail,
): UwDiagnostic[] {
  const diagnostics: UwDiagnostic[] = []
  const foundations = new Set<string>()
  for (const foundation of input.foundations) {
    const key = `${foundation.parent}\u0000${foundation.child}`
    if (foundations.has(key) || parents.get(foundation.child) !== foundation.parent)
      diagnostics.push(fail('framing-foundation-invalid', 'A foundation must be a unique immediate child'))
    foundations.add(key)
    if (foundationUnblocked(input, foundation))
      diagnostics.push(fail('framing-foundation-unblocked', 'Every sibling must depend on its declared foundation'))
  }
  return diagnostics
}

export function validateTopology(input: FramingAggregateInput): UwDiagnostic[] {
  const repository = aggregateRepository(input)
  const fail: Fail = (code, message) => repositoryDiagnostic(repository, code, message)
  const members = new Map(input.members.map((member) => [member.slot.key, member]))
  const edges = edgeTopology(input, members, fail)
  return [
    ...edges.diagnostics,
    ...coverageTopology(input, members, fail),
    ...foundationTopology(input, edges.parents, fail),
  ]
}
