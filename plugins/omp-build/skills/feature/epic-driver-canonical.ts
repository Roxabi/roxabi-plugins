import { assessUwAdmission, isWayfinder, projectNativeUwChildren, sameScope } from '../../dist/contracts.js'
import type { UwAdmission } from '../../engine/uw-admission.ts'
import type { SpecSnapshot } from '../../engine/uw-spec.ts'
import type { UwRead, UwReadPort } from '../../roxabi/uw-contract.ts'
import { readCurrentChildrenProjection } from '../../roxabi/uw-current-facts.ts'
import { Refused, uwReadPort } from './epic-driver-runtime'
import type { OwnUwObservation } from './epic-types'

type OwnUwDiagnostic = Extract<OwnUwObservation, { status: 'refused' }>['diagnostics'][number]
type OwnUwIdentityAllocations = Extract<OwnUwObservation, { status: 'framed' }>['identityAllocations']
type OwnUwRead = UwRead
type OwnUwTier = Extract<OwnUwObservation, { status: 'framed' }>['tier']

export type CanonicalEpic = {
  full: string
  parentAdmission: UwAdmission
  native: Map<string, OwnUwRead['graph']['nodes'][number]>
  nodes: OwnUwRead['graph']['nodes'][number][]
  ownUws: Map<number, OwnUwObservation>
}

function diagnostic(uw: { repository: string; target: string }, code: string, message: string): OwnUwDiagnostic {
  return { code, message, location: { kind: 'native', uw, connection: 'state' }, related: [] }
}

function observationDiagnostics(read: OwnUwRead): OwnUwDiagnostic[] {
  return [
    ...(read.graph.status === 'incomplete' ? read.graph.diagnostics : []),
    ...(read.proposed.ok ? [] : read.proposed.diagnostics),
    ...(read.accepted.status === 'refused' ? read.accepted.diagnostics : []),
    ...(read.identity.ok ? [] : read.identity.diagnostics),
    ...read.admission.framed.diagnostics,
  ]
}

function identityAllocations(read: OwnUwRead): OwnUwIdentityAllocations {
  return read.identity.ok
    ? [...read.identity.value.allocations].map(([id, allocation]) => ({ id, allocationRef: allocation }))
    : []
}

function tierOf(labels: readonly string[]): OwnUwTier | null {
  const label = labels.find((item) => item === 'size:S' || item === 'size:F-lite' || item === 'size:F-full')
  if (label === 'size:S') return 'S'
  if (label === 'size:F-lite') return 'F-lite'
  if (label === 'size:F-full') return 'F-full'
  return null
}

function acceptedOwnSpec(
  read: OwnUwRead,
  current: SpecSnapshot,
  uw: { repository: string; target: string },
  tier: OwnUwTier,
  diagnostics: OwnUwDiagnostic[],
) {
  if (read.accepted.status !== 'accepted') return null
  if (!sameScope(read.accepted.value.ref.uw, uw))
    diagnostics.push(diagnostic(uw, 'unsettled-child', 'Accepted own Spec belongs to another UW'))
  if (current.spec.version !== read.accepted.value.snapshot.spec.version)
    diagnostics.push(diagnostic(uw, 'material-change-pending', 'Current child Spec differs from its accepted snapshot'))
  if (tier !== read.accepted.value.tier)
    diagnostics.push(diagnostic(uw, 'material-change-pending', 'Current child tier differs from its accepted tier'))
  const nativeChildren = projectNativeUwChildren({ uw, graph: read.graph, accepted: read.accepted })
  if (!nativeChildren.ok) diagnostics.push(...nativeChildren.diagnostics)
  return diagnostics.length === 0 ? read.accepted.value : null
}

function settledOwnUw(
  read: OwnUwRead,
  uw: { repository: string; target: string },
  diagnostics: OwnUwDiagnostic[],
  allocations: OwnUwIdentityAllocations,
): OwnUwObservation | null {
  const proposed = read.proposed
  if (diagnostics.length !== 0 || !proposed.ok || !read.identity.ok || read.graph.status !== 'complete') return null
  const root = read.graph.nodes.find((node) => sameScope(node.uw, uw))
  if (root === undefined) {
    diagnostics.push(diagnostic(uw, 'graph-incomplete', 'Own UW root was not observed'))
    return null
  }
  const tier = tierOf(root.labels)
  if (tier === null) {
    diagnostics.push(diagnostic(uw, 'tier-missing', 'Own UW has no native tier'))
    return null
  }
  if (read.accepted.status === 'absent')
    return {
      status: 'framed',
      snapshot: proposed.snapshot,
      tier,
      graphComplete: true,
      identityAllocations: allocations,
    }
  const accepted = acceptedOwnSpec(read, proposed.snapshot, uw, tier, diagnostics)
  return accepted === null
    ? null
    : { status: 'accepted', accepted, graphComplete: true, identityAllocations: allocations }
}

function refusalObservation(diagnostics: OwnUwDiagnostic[]): Extract<OwnUwObservation, { status: 'refused' }> {
  const reason = diagnostics.some((entry) => entry.code === 'graph-incomplete')
    ? 'incomplete'
    : diagnostics.some((entry) => entry.code === 'material-change-pending')
      ? 'changed-child'
      : 'unsettled'
  return { status: 'refused', reason, diagnostics }
}

async function observeOwnUw(
  readUw: UwReadPort['readUw'],
  uw: { repository: string; target: string },
): Promise<OwnUwObservation> {
  try {
    const read = await readUw(uw)
    const diagnostics = observationDiagnostics(read)
    const allocations = identityAllocations(read)
    return settledOwnUw(read, uw, diagnostics, allocations) ?? refusalObservation(diagnostics)
  } catch (error) {
    return {
      status: 'refused',
      reason: 'incomplete',
      diagnostics: [diagnostic(uw, 'graph-incomplete', error instanceof Error ? error.message : String(error))],
    }
  }
}

export function issueNumber(scope: { target: string }): number {
  const number = Number(scope.target.slice(scope.target.lastIndexOf('#') + 1))
  if (!Number.isSafeInteger(number) || number <= 0) throw new Refused(`invalid native issue scope ${scope.target}`)
  return number
}

/**
 * The canonical authority observation for an Epic run. PR enrichment is
 * deliberately absent: callers that need it add it to these native facts.
 */
export async function readCanonicalEpic(repo: string, epic: number, full: string): Promise<CanonicalEpic> {
  const reader = await uwReadPort(repo)
  const scope = { repository: full, target: `${full}#${epic}` }
  const parent = await reader.readUw(scope)
  if (parent.graph.status !== 'complete')
    throw new Refused(
      `epic #${epic} native graph is incomplete: ${parent.graph.diagnostics.map((entry) => entry.message).join('; ')}`,
    )
  const native = new Map(parent.graph.nodes.map((node) => [`${node.uw.repository}\0${node.uw.target}`, node]))
  const root = native.get(`${scope.repository}\0${scope.target}`)
  if (root === undefined) throw new Refused(`epic #${epic} was not observed in its native graph`)
  const nodes = root.children.flatMap((childScope) => {
    if (childScope.repository !== full)
      throw new Refused(`the Epic run delivers only ${full}; sub-issues elsewhere: ${childScope.target}`)
    const child = native.get(`${childScope.repository}\0${childScope.target}`)
    if (child === undefined) throw new Refused(`native child ${childScope.target} was not observed`)
    return isWayfinder(child) ? [] : [child]
  })
  const observedReader = parent.observedReader ?? reader
  const [currentChildren, ownUws] = await Promise.all([
    readCurrentChildrenProjection({ uw: scope, read: parent, reader: observedReader }),
    Promise.all(
      nodes.map(async (node) => [issueNumber(node.uw), await observeOwnUw(observedReader.readUw, node.uw)] as const),
    ),
  ])
  const parentAdmission = parent.identity.ok
    ? assessUwAdmission({
        uw: scope,
        graph: parent.graph,
        proposed: parent.proposed,
        accepted: parent.accepted,
        identities: parent.identity.value,
        phase: 'delivery-transition',
        currentChildren,
      })
    : parent.admission
  return { full, parentAdmission, native, nodes, ownUws: new Map(ownUws) }
}
