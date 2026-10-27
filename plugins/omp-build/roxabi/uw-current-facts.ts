import { isWayfinder, unknownWayfinderLabels } from '../dist/contracts.js'
import type { Scope } from '../engine/record-values.ts'
import type { CurrentChildrenProjection } from '../engine/uw-admission.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { AssessSpecExact } from '../engine/workflow-receipt-schema.ts'
import type { UwRead, UwReadPort } from './uw-contract.ts'

export type CurrentOwnSpecFacts = {
  currentSpec: AssessSpecExact['proposed']
  identityAllocations: AssessSpecExact['identityAllocations']
}

export type CurrentOwnSpecFactsResult<T> = { ok: true; value: T } | { ok: false; diagnostics: readonly UwDiagnostic[] }

function sameScope(left: Scope, right: Scope): boolean {
  return left.repository === right.repository && left.target === right.target
}

function diagnostic(uw: Scope, code: string, message: string): UwDiagnostic {
  return { code, message, location: { kind: 'native', uw, connection: 'state' }, related: [] }
}

function tier(
  uw: Scope,
  labels: readonly string[],
): CurrentOwnSpecFactsResult<CurrentOwnSpecFacts['currentSpec']['tier']> {
  const values = labels.filter((label) => label === 'size:S' || label === 'size:F-lite' || label === 'size:F-full')
  if (values.length !== 1)
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          uw,
          values.length === 0 ? 'tier-missing' : 'tier-conflicting',
          'UW must have exactly one native size tier',
        ),
      ],
    }
  return { ok: true, value: values[0] === 'size:S' ? 'S' : values[0] === 'size:F-lite' ? 'F-lite' : 'F-full' }
}

function allocationRefs(
  uw: Scope,
  read: UwRead,
): CurrentOwnSpecFactsResult<CurrentOwnSpecFacts['identityAllocations']> {
  if (!read.identity.ok) return { ok: false, diagnostics: read.identity.diagnostics }
  if (!read.proposed.ok) return { ok: false, diagnostics: read.proposed.diagnostics }
  const references: CurrentOwnSpecFacts['identityAllocations'] = []
  for (const item of [...read.proposed.snapshot.spec.criteria, ...read.proposed.snapshot.spec.invariants]) {
    const allocation = read.identity.value.allocations.get(item.id)
    if (allocation === undefined || read.identity.value.retired.has(item.id))
      return {
        ok: false,
        diagnostics: [
          diagnostic(uw, 'spec-ledger-incomplete', 'Current proposed Spec has unknown or retired identities'),
        ],
      }
    references.push(allocation)
  }
  return { ok: true, value: references }
}

function root(uw: Scope, read: UwRead): CurrentOwnSpecFactsResult<NonNullable<UwRead['graph']['nodes'][number]>> {
  if (read.graph.status !== 'complete') return { ok: false, diagnostics: read.graph.diagnostics }
  const node = read.graph.nodes.find((candidate) => sameScope(candidate.uw, uw))
  if (node === undefined)
    return { ok: false, diagnostics: [diagnostic(uw, 'graph-root-missing', 'UW graph root is absent')] }
  const unknownWayfinders = unknownWayfinderLabels(node)
  if (unknownWayfinders.length > 0)
    return {
      ok: false,
      diagnostics: [
        diagnostic(uw, 'wayfinder-unknown', `UW has unknown wayfinder labels: ${unknownWayfinders.join(', ')}`),
      ],
    }
  return { ok: true, value: node }
}

type CurrentChildCommitment = CurrentOwnSpecFacts['currentSpec']['children'][number]

async function childCommitment(
  child: Scope,
  reader: UwReadPort,
): Promise<CurrentOwnSpecFactsResult<CurrentChildCommitment | null>> {
  const childRead = await reader.readUw(child)
  const childRoot = root(child, childRead)
  if (!childRoot.ok) return childRoot
  if (isWayfinder(childRoot.value)) return { ok: true, value: null }
  if (!childRead.admission.framed.ok) return { ok: false, diagnostics: childRead.admission.framed.diagnostics }
  if (childRead.accepted.status === 'refused') return { ok: false, diagnostics: childRead.accepted.diagnostics }
  if (!childRead.proposed.ok) return { ok: false, diagnostics: childRead.proposed.diagnostics }
  const allocations = allocationRefs(child, childRead)
  if (!allocations.ok) return allocations
  const childTier = tier(child, childRoot.value.labels)
  if (!childTier.ok) return childTier
  return {
    ok: true,
    value: {
      scope: child,
      specVersion: childRead.proposed.snapshot.spec.version,
      snapshot: childRead.proposed.snapshot,
      tier: childTier.value,
    },
  }
}

async function currentChildCommitments(input: {
  uw: Scope
  read: UwRead
  reader: UwReadPort
}): Promise<CurrentOwnSpecFactsResult<CurrentOwnSpecFacts['currentSpec']['children']>> {
  const rootNode = root(input.uw, input.read)
  if (!rootNode.ok) return rootNode
  const commitments: CurrentChildCommitment[] = []
  const reader = input.read.observedReader ?? input.reader
  const childScopes = [...rootNode.value.children].sort((left, right) => {
    const leftKey = `${left.repository}\0${left.target}`
    const rightKey = `${right.repository}\0${right.target}`
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
  })
  for (const child of childScopes) {
    const commitment = await childCommitment(child, reader)
    if (!commitment.ok) return commitment
    if (commitment.value !== null) commitments.push(commitment.value)
  }
  return { ok: true, value: commitments }
}

/** Current child commitments are native/proposed observations, never accepted child snapshots. */
export async function readCurrentChildrenProjection(input: {
  uw: Scope
  read: UwRead
  reader: UwReadPort
}): Promise<CurrentChildrenProjection> {
  const commitments = await currentChildCommitments(input)
  return commitments.ok
    ? {
        ok: true,
        value: commitments.value.map(({ scope, specVersion, tier }) => ({ scope, specVersion, tier })),
      }
    : commitments
}

/**
 * Rebuilds the exact current native Spec projection for assessment/control.
 * Child commitments come from framed current proposals and durable ledgers, not
 * from their accepted delivery states; accepted replay remains the engine's
 * baseline for material delta calculation.
 */
export async function readCurrentOwnSpecFacts(input: {
  uw: Scope
  read: UwRead
  reader: UwReadPort
}): Promise<CurrentOwnSpecFactsResult<CurrentOwnSpecFacts>> {
  const rootNode = root(input.uw, input.read)
  if (!rootNode.ok) return rootNode
  if (isWayfinder(rootNode.value))
    return {
      ok: false,
      diagnostics: [diagnostic(input.uw, 'wayfinder-not-uw', 'Wayfinder issues cannot receive a UW Spec control')],
    }
  if (!input.read.proposed.ok) return { ok: false, diagnostics: input.read.proposed.diagnostics }
  const ownAllocations = allocationRefs(input.uw, input.read)
  if (!ownAllocations.ok) return ownAllocations
  const ownTier = tier(input.uw, rootNode.value.labels)
  if (!ownTier.ok) return ownTier
  const children = await currentChildCommitments(input)
  if (!children.ok) return children
  return {
    ok: true,
    value: {
      currentSpec: { snapshot: input.read.proposed.snapshot, tier: ownTier.value, children: children.value },
      identityAllocations: ownAllocations.value,
    },
  }
}
