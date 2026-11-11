import { canonicalValueDigest, parentCoverageSchema, validParentCoverage } from '../dist/contracts.js'
import type { AcceptedOwnSpec } from '../engine/workflow-accepted-spec-types.ts'
import type { ParentCoverage } from '../engine/workflow-mandate-schema.ts'
import type { FeatureAuthority } from './feature-continuation-admission.ts'
import type { ContinueFeatureResult, ParentCoverageRequest } from './feature-contract.ts'
import type { UwRead } from './uw-contract.ts'
import type { CurrentOwnSpecFacts } from './uw-current-facts.ts'
/** Construct the exact target-specific basis for a new Mandate's initial admission. */
export function initialCoverageBasis(
  scope: FeatureAuthority['scope'],
  currentSpec: Omit<CurrentOwnSpecFacts['currentSpec'], 'coverage'>,
  accepted: ParentCoverageRequest['accepted'] = null,
): ParentCoverageRequest {
  return {
    parent: { uw: scope, version: currentSpec.snapshot.spec.version },
    accepted,
    inheritedOwnSpecRefs: currentSpec.inheritedOwnSpecRefs,
    criteria: currentSpec.snapshot.spec.criteria,
    children: currentSpec.children.map((child) => ({
      scope: child.scope,
      specVersion: child.specVersion,
      tier: child.tier,
      criteria: child.snapshot.spec.criteria,
    })),
  }
}

export function selectInitialCoverage(
  scope: FeatureAuthority['scope'],
  read: UwRead,
  currentSpec: Omit<CurrentOwnSpecFacts['currentSpec'], 'coverage'>,
  suppliedCoverage?: ParentCoverage | null,
  suppliedBasis?: ParentCoverageRequest,
): { coverage: ParentCoverage | null } | ContinueFeatureResult {
  return selectCoverage(
    currentSpec,
    initialCoverageBasis(scope, currentSpec),
    read.accepted.status === 'accepted' ? read.accepted.value.coverage : null,
    suppliedCoverage,
    suppliedBasis,
  )
}

export function selectSuccessorCoverage(
  scope: FeatureAuthority['scope'],
  currentSpec: Omit<CurrentOwnSpecFacts['currentSpec'], 'coverage'>,
  historical: AcceptedOwnSpec,
  suppliedCoverage?: ParentCoverage | null,
  suppliedBasis?: ParentCoverageRequest,
): { coverage: ParentCoverage | null } | ContinueFeatureResult {
  const metadata = historical.chain.at(-1)?.source
  if (metadata === undefined) return { kind: 'blocked', reason: 'successor-antecedent-unconfirmed' }
  return selectCoverage(
    currentSpec,
    initialCoverageBasis(scope, currentSpec, { own: historical.ref, metadata }),
    historical.coverage,
    suppliedCoverage,
    suppliedBasis,
  )
}

function selectCoverage(
  currentSpec: Omit<CurrentOwnSpecFacts['currentSpec'], 'coverage'>,
  coverageRequest: ParentCoverageRequest,
  fallback: ParentCoverage | null,
  suppliedCoverage?: ParentCoverage | null,
  suppliedBasis?: ParentCoverageRequest,
): { coverage: ParentCoverage | null } | ContinueFeatureResult {
  if (
    suppliedCoverage !== undefined &&
    (suppliedBasis === undefined || canonicalValueDigest(suppliedBasis) !== canonicalValueDigest(coverageRequest))
  )
    return { kind: 'blocked', reason: 'parent-coverage-intent-changed', coverageRequest }
  const parsedCoverage = suppliedCoverage == null ? null : parentCoverageSchema.safeParse(suppliedCoverage)
  if (parsedCoverage !== null && !parsedCoverage.success)
    return { kind: 'blocked', reason: 'parent-coverage-intent-invalid' }
  const coverage = currentSpec.children.length === 0 ? null : (parsedCoverage?.data ?? fallback)
  if (currentSpec.children.length > 0 && coverage === null)
    return { kind: 'blocked', reason: 'parent-coverage-intent-required', coverageRequest }
  if (currentSpec.children.length === 0 && suppliedCoverage != null)
    return { kind: 'blocked', reason: 'parent-coverage-intent-invalid' }
  return validateInitialCoverage(coverageRequest.parent.uw, currentSpec, coverage, suppliedCoverage, coverageRequest)
}

function validateInitialCoverage(
  scope: FeatureAuthority['scope'],
  currentSpec: Omit<CurrentOwnSpecFacts['currentSpec'], 'coverage'>,
  coverage: ParentCoverage | null,
  suppliedCoverage: ParentCoverage | null | undefined,
  coverageRequest: ParentCoverageRequest,
): { coverage: ParentCoverage | null } | ContinueFeatureResult {
  const validCoverage = validParentCoverage({
    own: { uw: scope, version: currentSpec.snapshot.spec.version, snapshot: currentSpec.snapshot },
    children: currentSpec.children,
    coverage,
  })
  if (!validCoverage)
    return suppliedCoverage === undefined && currentSpec.children.length > 0
      ? { kind: 'blocked', reason: 'parent-coverage-intent-required', coverageRequest }
      : { kind: 'blocked', reason: 'parent-coverage-intent-invalid' }
  return { coverage }
}
