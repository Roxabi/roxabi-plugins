import {
  assessCauseHolds,
  assessUwAdmission,
  canonicalValueDigest,
  sameScope,
  terminalParentChildrenProblem,
} from '../dist/contracts.js'
import type { AcceptedOwnSpec } from '../engine/workflow-accepted-spec-types.ts'
import type { MandateRecord } from '../engine/workflow-control.ts'
import { bindExternalRef, historyFor } from '../engine/workflow-control.ts'
import type { ParentCoverage } from '../engine/workflow-mandate-schema.ts'
import type { FeatureAuthority } from './feature-continuation-admission.ts'
import type { ContinueFeatureResult, ParentCoverageRequest } from './feature-contract.ts'
import { discoverFramingCoverageIntent, resolveFramingCoverageIntent } from './feature-framing-coverage.ts'
import { selectInitialCoverage, selectSuccessorCoverage } from './feature-initial-coverage.ts'
import type { UwRead, UwReadPort } from './uw-contract.ts'
import { readCurrentFramingFacts } from './uw-current-facts.ts'

type FreshFramingFacts = Extract<Awaited<ReturnType<typeof readCurrentFramingFacts>>, { ok: true }>['value']

export async function freshOwnSpec(
  scope: FeatureAuthority['scope'],
  read: UwRead | null,
  reader: UwReadPort | undefined,
  suppliedCoverage?: ParentCoverage | null,
  suppliedBasis?: ParentCoverageRequest,
): Promise<
  | Pick<MandateRecord['payload'], 'ownSpec' | 'tier' | 'children' | 'inheritedOwnSpecRefs' | 'coverage'>
  | ContinueFeatureResult
> {
  if (read === null || reader === undefined) return { kind: 'blocked', reason: 'uw-read-required' }
  const facts = await freshFraming(scope, read)
  if ('kind' in facts) return facts
  const { currentSpec, identityAllocations } = facts
  const approved = await framingCoverageForInitial(
    scope,
    read,
    currentSpec.children.length,
    suppliedCoverage,
    suppliedBasis,
  )
  if ('kind' in approved) return approved
  const selectedCoverage = selectInitialCoverage(scope, read, currentSpec, approved.coverage, approved.basis)
  if ('kind' in selectedCoverage) return selectedCoverage
  return {
    ownSpec: {
      uw: scope,
      version: currentSpec.snapshot.spec.version,
      snapshot: currentSpec.snapshot,
      identityAllocations,
    },
    tier: currentSpec.tier,
    children: currentSpec.children,
    inheritedOwnSpecRefs: currentSpec.inheritedOwnSpecRefs,
    coverage: selectedCoverage.coverage,
  }
}

/** Historical framing is a factual operand; current delivery acceptance remains refused. */
export async function freshSuccessorOwnSpec(
  scope: FeatureAuthority['scope'],
  read: UwRead,
  historical: AcceptedOwnSpec,
  suppliedCoverage?: ParentCoverage | null,
  suppliedBasis?: ParentCoverageRequest,
  contextHandoff = false,
): Promise<
  | Pick<MandateRecord['payload'], 'ownSpec' | 'tier' | 'children' | 'inheritedOwnSpecRefs' | 'coverage'>
  | ContinueFeatureResult
> {
  const facts = await freshFraming(scope, read)
  if ('kind' in facts) return facts
  const holds = assessCauseHolds({
    uw: scope,
    waits: read.completion.waits,
    dependencies: read.completion.dependencies,
  })
  if (holds.length) return { kind: 'blocked', reason: 'successor-cause-held', diagnostics: holds }
  const engagement = terminalParentChildrenProblem(
    { own: historical.ref, graph: read.graph, histories: read.histories },
    historical,
  )
  if (engagement !== null)
    return { kind: 'blocked', reason: 'successor-child-engagement-unconfirmed', diagnostics: engagement.diagnostics }
  const { currentSpec, identityAllocations } = facts
  if (!sameSuccessorCommitments(scope, currentSpec, historical))
    return { kind: 'blocked', reason: 'successor-commitments-changed' }
  const acceptedAllocations = contextHandoff ? acceptedHandoffAllocations(historical, read) : identityAllocations
  if (acceptedAllocations === null) return { kind: 'blocked', reason: 'successor-accepted-identities-unconfirmed' }
  const snapshot = contextHandoff ? historical.snapshot : currentSpec.snapshot
  const ownSpec = {
    uw: scope,
    version: snapshot.spec.version,
    snapshot,
    identityAllocations: acceptedAllocations,
  }
  const selectedCoverage = contextHandoff
    ? { coverage: historical.coverage }
    : selectSuccessorCoverage(scope, currentSpec, historical, suppliedCoverage, suppliedBasis)
  if ('kind' in selectedCoverage) return selectedCoverage
  return {
    ownSpec,
    tier: contextHandoff ? historical.tier : currentSpec.tier,
    children: historical.children,
    inheritedOwnSpecRefs: historical.inheritedOwnSpecRefs,
    coverage: selectedCoverage.coverage,
  }
}

function sameSuccessorCommitments(
  scope: FeatureAuthority['scope'],
  currentSpec: FreshFramingFacts['currentSpec'],
  historical: AcceptedOwnSpec,
): boolean {
  if (
    !sameScope(historical.ref.uw, scope) ||
    canonicalValueDigest(currentSpec.inheritedOwnSpecRefs) !== canonicalValueDigest(historical.inheritedOwnSpecRefs) ||
    currentSpec.children.length !== historical.children.length
  )
    return false
  return historical.children.every((retained) => {
    const current = currentSpec.children.find((child) => sameScope(child.scope, retained.scope))
    return (
      current !== undefined &&
      current.specVersion === retained.specVersion &&
      current.tier === retained.tier &&
      canonicalValueDigest(current.snapshot.spec) === canonicalValueDigest(retained.snapshot.spec)
    )
  })
}

function acceptedHandoffAllocations(
  historical: AcceptedOwnSpec,
  read: UwRead,
): FreshFramingFacts['identityAllocations'] | null {
  const step = historical.chain[historical.chain.length - 1]
  const source = step?.kind === 'accept-material' ? step.assessment : step?.source
  const home = source === undefined ? null : historyFor(source.scope, read.histories)
  const bound = source === undefined || home === null ? null : bindExternalRef(source, home)
  if (step === undefined || bound === null || !bound.ok) return null
  if (step.kind === 'mandate' && bound.value.kind === 'mandate') return bound.value.payload.ownSpec.identityAllocations
  if (
    step.kind !== 'mandate' &&
    bound.value.kind === 'action-receipt' &&
    bound.value.payload.action === 'assess-spec' &&
    bound.value.payload.phase === 'result'
  )
    return bound.value.payload.exactInputs.identityAllocations
  return null
}

async function freshFraming(
  scope: FeatureAuthority['scope'],
  read: UwRead,
): Promise<FreshFramingFacts | ContinueFeatureResult> {
  if (read.admission.aggregate.status === 'held')
    return { kind: 'blocked', reason: read.admission.aggregate.code, diagnostics: read.admission.aggregate.diagnostics }
  if (!read.identity.ok)
    return { kind: 'blocked', reason: 'uw-identities-unconfirmed', diagnostics: read.identity.diagnostics }
  const initial = assessUwAdmission({
    uw: scope,
    graph: read.graph,
    proposed: read.proposed,
    accepted: read.accepted,
    identities: read.identity.value,
    histories: read.histories,
    catalogues: read.catalogues,
    completion: read.completion,
    phase: 'initial-selection',
  })
  if (!initial.deliverable.ok)
    return { kind: 'blocked', reason: 'uw-initial-admission-refused', diagnostics: initial.deliverable.diagnostics }
  const facts = await readCurrentFramingFacts({ uw: scope, read })
  return facts.ok
    ? facts.value
    : { kind: 'blocked', reason: 'uw-current-facts-refused', diagnostics: facts.diagnostics }
}

async function framingCoverageForInitial(
  scope: FeatureAuthority['scope'],
  read: UwRead,
  childCount: number,
  coverage?: ParentCoverage | null,
  basis?: ParentCoverageRequest,
): Promise<
  { coverage: ParentCoverage | null | undefined; basis: ParentCoverageRequest | undefined } | ContinueFeatureResult
> {
  if (read.admission.aggregate.status !== 'complete' || read.accepted.status !== 'absent') return { coverage, basis }
  const discovered = discoverFramingCoverageIntent(scope, read)
  if ('kind' in discovered) return discovered
  if (discovered.intent === null)
    return childCount > 0 ? { kind: 'blocked', reason: 'parent-coverage-intent-required' } : { coverage, basis }
  const approved = await resolveFramingCoverageIntent({ uw: scope, read, intent: discovered.intent })
  if ('kind' in approved) return approved
  if (
    coverage !== undefined &&
    (basis === undefined ||
      canonicalValueDigest(coverage) !== canonicalValueDigest(approved.coverage) ||
      canonicalValueDigest(basis) !== canonicalValueDigest(approved.basis))
  )
    return { kind: 'blocked', reason: 'parent-coverage-intent-changed', coverageRequest: approved.basis }
  return approved
}
