import { canonicalValueDigest, parentCoverageSchema, validParentCoverage } from '../dist/contracts.js'
import type { ParentCoverage } from '../engine/workflow-mandate-schema.ts'
import type { FeatureAuthority } from './feature-continuation-admission.ts'
import type { ContinueFeatureResult, ParentCoverageRequest } from './feature-contract.ts'
import type { UwRead } from './uw-contract.ts'
import type { CurrentOwnSpecFacts } from './uw-current-facts.ts'
/** Construct the exact current target-specific basis used by initial admission. */
export function initialCoverageBasis(
  scope: FeatureAuthority['scope'],
  currentSpec: Omit<CurrentOwnSpecFacts['currentSpec'], 'coverage'>,
): ParentCoverageRequest {
  return {
    parent: { uw: scope, version: currentSpec.snapshot.spec.version },
    accepted: null,
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
  const coverageRequest = initialCoverageBasis(scope, currentSpec)
  if (
    suppliedCoverage !== undefined &&
    (suppliedBasis === undefined || canonicalValueDigest(suppliedBasis) !== canonicalValueDigest(coverageRequest))
  )
    return { kind: 'blocked', reason: 'parent-coverage-intent-changed', coverageRequest }
  const parsedCoverage = suppliedCoverage == null ? null : parentCoverageSchema.safeParse(suppliedCoverage)
  if (parsedCoverage !== null && !parsedCoverage.success)
    return { kind: 'blocked', reason: 'parent-coverage-intent-invalid' }
  const coverage =
    currentSpec.children.length === 0
      ? null
      : (parsedCoverage?.data ?? (read.accepted.status === 'accepted' ? read.accepted.value.coverage : null))
  if (currentSpec.children.length > 0 && coverage === null)
    return { kind: 'blocked', reason: 'parent-coverage-intent-required', coverageRequest }
  if (currentSpec.children.length === 0 && suppliedCoverage != null)
    return { kind: 'blocked', reason: 'parent-coverage-intent-invalid' }
  return validateInitialCoverage(scope, currentSpec, coverage, suppliedCoverage, coverageRequest)
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
