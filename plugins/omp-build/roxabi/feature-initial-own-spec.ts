import { assessUwAdmission, canonicalValueDigest } from '../dist/contracts.js'
import type { MandateRecord } from '../engine/workflow-control.ts'
import type { ParentCoverage } from '../engine/workflow-mandate-schema.ts'
import type { FeatureAuthority } from './feature-continuation-admission.ts'
import type { ContinueFeatureResult, ParentCoverageRequest } from './feature-contract.ts'
import { discoverFramingCoverageIntent, resolveFramingCoverageIntent } from './feature-framing-coverage.ts'
import { selectInitialCoverage } from './feature-initial-coverage.ts'
import type { UwRead, UwReadPort } from './uw-contract.ts'
import { readCurrentFramingFacts } from './uw-current-facts.ts'

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
  if (read.admission.aggregate?.status === 'held')
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
  if (!facts.ok) return { kind: 'blocked', reason: 'uw-current-facts-refused', diagnostics: facts.diagnostics }
  const { currentSpec, identityAllocations } = facts.value
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

async function framingCoverageForInitial(
  scope: FeatureAuthority['scope'],
  read: UwRead,
  childCount: number,
  coverage?: ParentCoverage | null,
  basis?: ParentCoverageRequest,
): Promise<
  { coverage: ParentCoverage | null | undefined; basis: ParentCoverageRequest | undefined } | ContinueFeatureResult
> {
  if (read.admission.aggregate?.status !== 'complete' || read.accepted.status !== 'absent') return { coverage, basis }
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
