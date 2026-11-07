import {
  isWayfinder,
  parseIssueSpecBody,
  resolveCurrentInheritedOwnSpecRefs,
  resolveSpecIdentityLedger,
  unknownWayfinderLabels,
} from '../dist/contracts.js'
import type { Scope } from '../engine/record-values.ts'
import type { CurrentChildrenProjection } from '../engine/uw-admission.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { ParentCoverage } from '../engine/workflow-mandate-schema.ts'
import type { AssessSpecExact } from '../engine/workflow-receipt-schema.ts'
import type { AssessmentReplayContext } from '../engine/workflow-spec-authentication.ts'
import type { ParentCoverageRequest } from './feature-contract.ts'
import { assessmentCoverageFacts } from './uw-assessment-coverage.ts'
import type { UwRead } from './uw-contract.ts'
import { projectObservedOwnSpecFacts } from './uw-read-state.ts'

const factualReadContracts = { parseIssueSpecBody, resolveSpecIdentityLedger }

type CurrentChildCommitment = Extract<AssessSpecExact['proposed']['children'][number], { scope: Scope }>

export type CurrentOwnSpecFacts = {
  currentSpec: Omit<AssessSpecExact['proposed'], 'children'> & { children: CurrentChildCommitment[] }
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
  read: Pick<UwRead, 'identity' | 'proposed'>,
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

function root(
  uw: Scope,
  observation: UwRead['observation'],
): CurrentOwnSpecFactsResult<UwRead['graph']['nodes'][number]> {
  if (observation === undefined)
    return {
      ok: false,
      diagnostics: [diagnostic(uw, 'observation-missing', 'Current facts require a complete joint observation')],
    }
  if (observation.status !== 'complete') return { ok: false, diagnostics: observation.diagnostics }
  const node = observation.graph.nodes.find((candidate) => sameScope(candidate.uw, uw))
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

function childCommitment(
  child: Scope,
  observation: UwRead['observation'],
  assessmentReplay?: AssessmentReplayContext,
): CurrentOwnSpecFactsResult<CurrentChildCommitment | null> {
  const childRoot = root(child, observation)
  if (!childRoot.ok) return childRoot
  if (isWayfinder(childRoot.value)) return { ok: true, value: null }
  const observed = projectObservedOwnSpecFacts(factualReadContracts, { uw: child, observation, assessmentReplay })
  if (!observed.ok) return observed
  const facts = observed.value
  if (!facts.proposed.ok) return { ok: false, diagnostics: facts.proposed.diagnostics }
  const allocations = allocationRefs(child, facts)
  if (!allocations.ok) return allocations
  const childTier = tier(child, facts.node.labels)
  if (!childTier.ok) return childTier
  return {
    ok: true,
    value: {
      scope: child,
      specVersion: facts.proposed.snapshot.spec.version,
      snapshot: facts.proposed.snapshot,
      tier: childTier.value,
    },
  }
}

/** Project any observed candidates from one complete cut, without admission, own mandate or I/O. */
export function projectObservedChildCommitments(input: {
  scopes: readonly Scope[]
  observation: UwRead['observation']
  assessmentReplay?: AssessmentReplayContext
}): CurrentOwnSpecFactsResult<CurrentChildCommitment[]> {
  if (input.observation.status !== 'complete') return { ok: false, diagnostics: input.observation.diagnostics }
  const commitments: CurrentChildCommitment[] = []
  const childScopes = [...input.scopes].sort((left, right) => {
    const leftKey = `${left.repository}\0${left.target}`
    const rightKey = `${right.repository}\0${right.target}`
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
  })
  let previous: Scope | undefined
  for (const child of childScopes) {
    if (previous !== undefined && sameScope(previous, child))
      return {
        ok: false,
        diagnostics: [diagnostic(child, 'child-scope-duplicate', 'Candidate child scopes must be unique')],
      }
    previous = child
    const commitment = childCommitment(child, input.observation, input.assessmentReplay)
    if (!commitment.ok) return commitment
    if (commitment.value !== null) commitments.push(commitment.value)
  }
  return { ok: true, value: commitments }
}

function currentChildCommitments(input: {
  uw: Scope
  read: UwRead
  assessmentReplay?: AssessmentReplayContext
}): CurrentOwnSpecFactsResult<CurrentOwnSpecFacts['currentSpec']['children']> {
  const rootNode = root(input.uw, input.read.observation)
  if (!rootNode.ok) return rootNode
  return projectObservedChildCommitments({
    scopes: rootNode.value.children,
    observation: input.read.observation,
    assessmentReplay: input.assessmentReplay,
  })
}

/** Current child commitments are native/proposed observations, never accepted child snapshots. */
export async function readCurrentChildrenProjection(input: {
  uw: Scope
  read: UwRead
}): Promise<CurrentChildrenProjection> {
  const commitments = currentChildCommitments(input)
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
export async function readCurrentFramingFacts(input: {
  uw: Scope
  read: UwRead
  assessmentReplay?: AssessmentReplayContext
}): Promise<
  CurrentOwnSpecFactsResult<
    Omit<CurrentOwnSpecFacts, 'currentSpec'> & {
      currentSpec: Omit<CurrentOwnSpecFacts['currentSpec'], 'coverage'>
    }
  >
> {
  const rootNode = root(input.uw, input.read.observation)
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
  const children = currentChildCommitments(input)
  if (!children.ok) return children
  const inherited = resolveCurrentInheritedOwnSpecRefs(
    input.uw,
    input.read.observation.graph,
    input.read.observation.histories,
    input.assessmentReplay,
  )
  if (!inherited.ok) return inherited
  return {
    ok: true,
    value: {
      currentSpec: {
        snapshot: input.read.proposed.snapshot,
        tier: ownTier.value,
        children: children.value,
        inheritedOwnSpecRefs: [...inherited.value],
      },
      identityAllocations: ownAllocations.value,
    },
  }
}

export async function readCurrentOwnSpecFacts(input: {
  uw: Scope
  read: UwRead
  assessmentReplay?: AssessmentReplayContext
}): Promise<CurrentOwnSpecFactsResult<CurrentOwnSpecFacts>> {
  const framing = await readCurrentFramingFacts(input)
  if (!framing.ok) return framing
  if (input.read.accepted.status === 'refused') return { ok: false, diagnostics: input.read.accepted.diagnostics }
  const baseline = input.read.accepted.status === 'accepted' ? input.read.accepted.value : null
  return {
    ok: true,
    value: {
      currentSpec: {
        ...framing.value.currentSpec,
        // Coverage remains authenticated metadata; changed assignments require explicit operator input.
        coverage: baseline?.coverage ?? null,
      },
      identityAllocations: framing.value.identityAllocations,
    },
  }
}

/** Rebuild a proposal from one observed cut; supplied coverage is intent, not authority. */
export async function readAssessmentSpecFacts(input: {
  uw: Scope
  read: UwRead
  assessmentReplay?: AssessmentReplayContext
  coverage?: ParentCoverage | null
  basis?: ParentCoverageRequest
}): Promise<
  | CurrentOwnSpecFactsResult<CurrentOwnSpecFacts>
  | {
      ok: false
      coverageRequest: ParentCoverageRequest
      reason: string
    }
> {
  const framing = await readCurrentFramingFacts(input)
  if (!framing.ok) return framing
  return assessmentCoverageFacts(input, framing)
}
