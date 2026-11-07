import type { IssueRef } from '../../issue-triage/skills/shared/domain/issue-write.ts'
import { readFramingMembership, recordsOf, resolveAcceptedSpec } from '../dist/contracts.js'
import type { Scope } from '../engine/record-values.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { CreatedUwRead, UwProposal, UwRead } from './uw-contract.ts'
import { issueRef } from './uw-operation-observation.ts'

type ParentAdmission = {
  guardParent(parent: IssueRef): Promise<void>
  scopeOf(issue: IssueRef): Scope
  read(uw: Scope): Promise<UwRead>
  readCreated(uw: Scope): Promise<CreatedUwRead>
}

type Relations = UwProposal['writes']['relations']

function relationEndpoints(relations: Relations): IssueRef[] {
  return [
    ...(relations.parent ? [relations.parent] : []),
    ...relations.addChildren,
    ...relations.removeChildren,
    ...relations.addBlockers,
    ...relations.removeBlockers,
  ]
}

function unreadable(uw: Scope, reason: string): readonly UwDiagnostic[] {
  return [
    {
      code: 'framing-aggregate-unreadable',
      message: `Relation endpoint could not be read: ${reason}`,
      location: { kind: 'native', uw, connection: 'state' },
      related: [],
    },
  ]
}

function hasHistoricalAcceptance(read: UwRead): boolean {
  const own = read.histories.find(
    (history) =>
      history.source.scope.repository === read.uw.repository && history.source.scope.target === read.uw.target,
  )
  if (own === undefined || !own.source.complete) return false
  return recordsOf(own).some(
    (record) =>
      record.kind === 'mandate' &&
      record.payload.format === 'omp-build-mandate/4' &&
      resolveAcceptedSpec(record, read.histories).ok,
  )
}

async function endpointAggregateHold(uw: Scope, ports: ParentAdmission): Promise<readonly UwDiagnostic[] | null> {
  const facts = await ports.readCreated(uw)
  if (facts.graph.status !== 'complete') return unreadable(uw, 'Native graph is incomplete')
  // Factual readback has no accepted authority. Only none/held are final here;
  // complete is provisional until the full read reconstructs actual acceptance.
  const membership = readFramingMembership({
    uw,
    graph: facts.graph,
    histories: facts.histories,
    accepted: {
      status: 'refused',
      diagnostics: unreadable(uw, 'Factual readback does not establish accepted Spec authority'),
    },
  })
  if (membership.status === 'none') return null
  if (membership.status === 'held') return membership.diagnostics
  const read = await ports.read(uw)
  if (read.observation.status !== 'complete' || read.graph.status !== 'complete')
    return unreadable(uw, 'Framing observation is incomplete')
  // A verified past acceptance remains a fact after pause or abandonment; it
  // does not restore an active Mandate or bypass the separate Parent guard.
  if (read.accepted.status === 'refused' && !hasHistoricalAcceptance(read))
    return unreadable(uw, 'Accepted Spec authority could not be established')
  const aggregate = read.admission.aggregate
  if (aggregate.status === 'complete') return null
  return aggregate.status === 'held'
    ? aggregate.diagnostics
    : unreadable(uw, 'Framing membership changed between observations')
}

/** The first held endpoint's aggregate diagnostics, an unreadable endpoint, or null when none is held. */
async function endpointHold(
  endpoints: readonly IssueRef[],
  ports: ParentAdmission,
): Promise<readonly UwDiagnostic[] | null> {
  const seen = new Set<string>()
  for (const endpoint of endpoints) {
    const uw = ports.scopeOf(endpoint)
    const key = `${uw.repository}\u0000${uw.target}`
    if (seen.has(key)) continue
    seen.add(key)
    try {
      const held = await endpointAggregateHold(uw, ports)
      if (held !== null) return held
    } catch (error) {
      return unreadable(uw, String(error))
    }
  }
  return null
}

/** The explicit parent, then the existing target when it gains children, each once. */
function insertionParents(proposal: UwProposal): IssueRef[] {
  const relations = proposal.writes.relations
  const parents: IssueRef[] = []
  if (relations.parent) parents.push(relations.parent)
  if (relations.addChildren.length === 0 || proposal.target.kind !== 'existing') return parents
  const parent = issueRef(proposal.target.uw)
  if (
    parent !== null &&
    !parents.some((item) => item.repository === parent.repository && item.number === parent.number)
  )
    parents.push(parent)
  return parents
}

async function parentGuardDiagnostics(
  parents: readonly IssueRef[],
  ports: ParentAdmission,
): Promise<readonly UwDiagnostic[]> {
  for (const parent of parents) {
    try {
      await ports.guardParent(parent)
    } catch (error) {
      const uw = ports.scopeOf(parent)
      return [
        {
          code: 'cause-parent-guard',
          message: error instanceof Error ? error.message : String(error),
          location: { kind: 'native', uw, connection: 'state' },
          related: [],
        },
      ]
    }
  }
  return []
}

export async function insertionDiagnostics(
  proposal: UwProposal,
  ports: ParentAdmission,
): Promise<readonly UwDiagnostic[]> {
  const held = await endpointHold(relationEndpoints(proposal.writes.relations), ports)
  if (held !== null) return held
  return parentGuardDiagnostics(insertionParents(proposal), ports)
}
