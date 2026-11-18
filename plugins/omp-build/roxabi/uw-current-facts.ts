import {
  createHistoricalAcceptedSpecContext,
  isWayfinder,
  parseIssueSpecBody,
  resolveCurrentInheritedOwnSpecRefs,
  resolveSpecIdentityLedger,
} from '../dist/contracts.js'
import type { Scope } from '../engine/record-values.ts'
import type { CurrentChildrenProjection } from '../engine/uw-admission.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { HistoricalAcceptedSpecContext } from '../engine/workflow-context-succession-inspection.ts'
import type { ParentCoverage } from '../engine/workflow-mandate-schema.ts'
import type { AssessSpecExact } from '../engine/workflow-receipt-schema.ts'
import type { AcceptedSpecInspection, AssessmentReplayContext } from '../engine/workflow-spec-authentication.ts'
import type { ParentCoverageRequest } from './feature-contract.ts'
import { assessmentCoverageFacts } from './uw-assessment-coverage.ts'
import type { UwRead } from './uw-contract.ts'
import { allocationRefs, diagnostic, root, tier } from './uw-current-facts-validation.ts'
import { projectObservedOwnSpecFacts } from './uw-read-state.ts'

const factualReadContracts = { createHistoricalAcceptedSpecContext, parseIssueSpecBody, resolveSpecIdentityLedger }

type CurrentChildCommitment = Extract<AssessSpecExact['proposed']['children'][number], { scope: Scope }>

export type CurrentOwnSpecFacts = {
  currentSpec: Omit<AssessSpecExact['proposed'], 'children'> & { children: CurrentChildCommitment[] }
  identityAllocations: AssessSpecExact['identityAllocations']
}

export type CurrentOwnSpecFactsResult<T> = { ok: true; value: T } | { ok: false; diagnostics: readonly UwDiagnostic[] }

function sameScope(left: Scope, right: Scope): boolean {
  return left.repository === right.repository && left.target === right.target
}

function childCommitment(
  child: Scope,
  observation: UwRead['observation'],
  assessmentReplay?: AssessmentReplayContext,
  assessmentInspection?: AcceptedSpecInspection,
  historical?: HistoricalAcceptedSpecContext,
): CurrentOwnSpecFactsResult<CurrentChildCommitment | null> {
  const childRoot = root(child, observation)
  if (!childRoot.ok) return childRoot
  if (isWayfinder(childRoot.value)) return { ok: true, value: null }
  const observed = projectObservedOwnSpecFacts(factualReadContracts, {
    uw: child,
    observation,
    assessmentReplay,
    assessmentInspection,
    historical,
  })
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
  assessmentInspection?: AcceptedSpecInspection
  historical?: HistoricalAcceptedSpecContext
}): CurrentOwnSpecFactsResult<CurrentChildCommitment[]> {
  if (input.observation.status !== 'complete') return { ok: false, diagnostics: input.observation.diagnostics }
  const prepared =
    input.historical === undefined
      ? createHistoricalAcceptedSpecContext(input.observation.histories)
      : { ok: true as const, value: input.historical }
  if (!prepared.ok)
    return {
      ok: false,
      diagnostics: [
        diagnostic(input.observation.root, 'history-unconfirmed', 'Historical Spec context cannot be authenticated'),
      ],
    }
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
    const commitment = childCommitment(
      child,
      input.observation,
      input.assessmentReplay,
      input.assessmentInspection,
      prepared.value,
    )
    if (!commitment.ok) return commitment
    if (commitment.value !== null) commitments.push(commitment.value)
  }
  return { ok: true, value: commitments }
}

function currentChildCommitments(input: {
  uw: Scope
  read: UwRead
  assessmentReplay?: AssessmentReplayContext
  assessmentInspection?: AcceptedSpecInspection
}): CurrentOwnSpecFactsResult<CurrentOwnSpecFacts['currentSpec']['children']> {
  const rootNode = root(input.uw, input.read.observation)
  if (!rootNode.ok) return rootNode
  return projectObservedChildCommitments({
    scopes: rootNode.value.children,
    observation: input.read.observation,
    assessmentReplay: input.assessmentReplay,
    assessmentInspection: input.assessmentInspection,
    historical: input.read.historical,
  })
}

/** Current child commitments are native/proposed observations, never accepted child snapshots. */
export async function readCurrentChildrenProjection(input: {
  uw: Scope
  read: UwRead
  assessmentReplay?: AssessmentReplayContext
  assessmentInspection?: AcceptedSpecInspection
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
  assessmentInspection?: AcceptedSpecInspection
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
  const prepared =
    input.read.historical === undefined
      ? createHistoricalAcceptedSpecContext(input.read.observation.histories)
      : { ok: true as const, value: input.read.historical }
  if (!prepared.ok)
    return {
      ok: false,
      diagnostics: [diagnostic(input.uw, 'history-unconfirmed', 'Historical Spec context cannot be authenticated')],
    }
  const children = currentChildCommitments({ ...input, read: { ...input.read, historical: prepared.value } })
  if (!children.ok) return children
  const inherited = resolveCurrentInheritedOwnSpecRefs(
    input.uw,
    input.read.observation.graph,
    input.read.observation.histories,
    input.assessmentReplay,
    input.assessmentInspection,
    prepared.value,
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
  assessmentInspection?: AcceptedSpecInspection
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
  assessmentInspection?: AcceptedSpecInspection
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
