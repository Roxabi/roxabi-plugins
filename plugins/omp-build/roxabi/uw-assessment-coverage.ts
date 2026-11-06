import {
  authenticatedAssessResult,
  bindExternalRef,
  canonicalValueDigest,
  capturedAssessmentSourcesMatch,
  capturedChildOwnSources,
  checkAuthenticatedSpecCompatibility,
  historyFor,
  isAssessResult,
  parentCoverageSchema,
  recordsOf,
  sameAssessedState,
  sameCurrentAssessedState,
  specAssessmentSchema,
  validParentCoverage,
} from '../dist/contracts.js'
import type { Scope } from '../engine/record-values.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { ParentCoverage } from '../engine/workflow-mandate-schema.ts'
import type { AssessResultRecord } from '../engine/workflow-spec-assessment.ts'
import type { AssessmentReplayContext } from '../engine/workflow-spec-authentication.ts'
import type { ParentCoverageRequest } from './feature-contract.ts'
import type { UwRead } from './uw-contract.ts'
import type { CurrentOwnSpecFacts, CurrentOwnSpecFactsResult } from './uw-current-facts.ts'

function diagnostic(uw: Scope, code: string, message: string): UwDiagnostic {
  return { code, message, location: { kind: 'native', uw, connection: 'state' }, related: [] }
}

type CoverageInput = Parameters<typeof assessmentCoverageFacts>[0]
type CoverageFraming = Parameters<typeof assessmentCoverageFacts>[1]
type Accepted = Extract<UwRead['accepted'], { status: 'accepted' }>['value']
type Mandate = Accepted['chain'][number]['source']
type Histories = Extract<UwRead['observation'], { status: 'complete' }>['histories']

function matchesAssessmentInputs(
  exact: AssessResultRecord['payload']['exactInputs'],
  accepted: Accepted,
  framing: CoverageFraming,
): boolean {
  return (
    sameAssessedState(exact.accepted, {
      ref: accepted.ref,
      snapshot: accepted.snapshot,
      tier: accepted.tier,
      children: accepted.children,
      inheritedOwnSpecRefs: accepted.inheritedOwnSpecRefs,
      coverage: accepted.coverage,
    }) &&
    sameCurrentAssessedState({ ...framing.value.currentSpec, coverage: exact.proposed.coverage }, exact.proposed) &&
    canonicalValueDigest(framing.value.identityAllocations) === canonicalValueDigest(exact.identityAllocations)
  )
}

function matchingCoverageCandidates(
  input: CoverageInput,
  framing: CoverageFraming,
  accepted: Accepted,
  mandate: Mandate,
  histories: Histories,
): (ParentCoverage | null)[] {
  const home = historyFor(input.uw, histories)
  const bound = home === null ? null : bindExternalRef(mandate, home)
  const candidates: (ParentCoverage | null)[] = []
  if (home === null || bound === null || !bound.ok || bound.value.kind !== 'mandate') return candidates
  for (const record of recordsOf(home)) {
    if (!isAssessResult(record)) continue
    const exact = record.payload.exactInputs
    if (!matchesAssessmentInputs(exact, accepted, framing)) continue
    const auth = authenticatedAssessResult(record, histories, mandate)
    const parsed = specAssessmentSchema.safeParse(record.payload.structured)
    const sources = capturedChildOwnSources(
      exact.accepted,
      exact.proposed,
      histories,
      exact.attachedChildren,
      input.assessmentReplay,
    )
    const frozenCoverage = parentCoverageSchema.nullable().safeParse(exact.proposed.coverage)
    if (
      !frozenCoverage.success ||
      record.payload.inputs.manifest.operands?.action !== 'assess-spec' ||
      record.payload.inputs.manifest.operands.origin.kind !== 'native-current'
    )
      continue
    if (
      !auth.ok ||
      !parsed.success ||
      parsed.data.compatibility.state !== 'consistent' ||
      sources === null ||
      canonicalValueDigest(sources.childOwnSources) !== canonicalValueDigest(exact.childOwnSources) ||
      !capturedAssessmentSourcesMatch(
        { childOwnSources: [], sourceRefs: accepted.sourceRefs },
        record.payload.inputs.manifest.acceptedSources,
        histories,
      ) ||
      !capturedAssessmentSourcesMatch(sources, record.payload.inputs.manifest.acceptedSources, histories) ||
      checkAuthenticatedSpecCompatibility(record, parsed.data, histories, bound.value) !== null
    )
      continue
    candidates.push(frozenCoverage.data)
  }
  return candidates
}

function childrenUnchanged(base: CoverageFraming['value']['currentSpec'], accepted: Accepted): boolean {
  return (
    canonicalValueDigest(
      base.children.map((child) => ({
        ...child,
        snapshot: { ...child.snapshot, raw: { ...child.snapshot.raw, lastEditedAt: null } },
      })),
    ) ===
    canonicalValueDigest(
      accepted.children.map((child) => ({
        ...child,
        snapshot: { ...child.snapshot, raw: { ...child.snapshot.raw, lastEditedAt: null } },
      })),
    )
  )
}

function resolveCoverage(
  input: CoverageInput,
  framing: CoverageFraming,
  accepted: Accepted,
  mandate: Mandate,
  observation: Extract<UwRead['observation'], { status: 'complete' }>,
  basis: ParentCoverageRequest,
):
  | CurrentOwnSpecFactsResult<CurrentOwnSpecFacts>
  | { ok: false; coverageRequest: ParentCoverageRequest; reason: string } {
  const base = framing.value.currentSpec
  if (
    input.coverage !== undefined &&
    input.basis !== undefined &&
    canonicalValueDigest(input.basis) !== canonicalValueDigest(basis)
  )
    return { ok: false, coverageRequest: basis, reason: 'parent-coverage-intent-changed' }
  let coverage = input.coverage
  const histories = observation.histories
  const candidates =
    coverage === undefined ? matchingCoverageCandidates(input, framing, accepted, mandate, histories) : []
  if (coverage === undefined) {
    if (candidates.length > 1) return { ok: false, coverageRequest: basis, reason: 'parent-coverage-intent-ambiguous' }
    if (candidates.length === 1) coverage = candidates[0]
    else if (childrenUnchanged(base, accepted)) coverage = accepted.coverage
    else return { ok: false, coverageRequest: basis, reason: 'parent-coverage-intent-required' }
  }
  const parsed = coverage === null ? { success: true as const, data: null } : parentCoverageSchema.safeParse(coverage)
  if (!parsed.success) return { ok: false, coverageRequest: basis, reason: 'parent-coverage-intent-invalid' }
  if (
    !validParentCoverage({
      own: { uw: input.uw, version: base.snapshot.spec.version, snapshot: base.snapshot },
      children: base.children,
      coverage: parsed.data,
    })
  )
    return { ok: false, coverageRequest: basis, reason: 'parent-coverage-intent-invalid' }
  return {
    ok: true,
    value: { currentSpec: { ...base, coverage: parsed.data }, identityAllocations: framing.value.identityAllocations },
  }
}

export function assessmentCoverageFacts(
  input: {
    uw: Scope
    read: UwRead
    assessmentReplay?: AssessmentReplayContext
    coverage?: ParentCoverage | null
    basis?: ParentCoverageRequest
  },
  framing: {
    ok: true
    value: Omit<CurrentOwnSpecFacts, 'currentSpec'> & {
      currentSpec: Omit<CurrentOwnSpecFacts['currentSpec'], 'coverage'>
    }
  },
):
  | CurrentOwnSpecFactsResult<CurrentOwnSpecFacts>
  | {
      ok: false
      coverageRequest: ParentCoverageRequest
      reason: string
    } {
  if (input.read.accepted.status !== 'accepted' || input.read.observation.status !== 'complete')
    return {
      ok: false,
      diagnostics: [diagnostic(input.uw, 'accepted-unavailable', 'Current accepted metadata is unavailable')],
    }
  const accepted = input.read.accepted.value
  const head = accepted.chain.at(-1)
  const mandate = accepted.chain[0]?.source
  if (!head || !mandate || mandate.kind !== 'mandate')
    return {
      ok: false,
      diagnostics: [diagnostic(input.uw, 'accepted-unavailable', 'Accepted metadata chain is empty')],
    }
  const base = framing.value.currentSpec
  const basis: ParentCoverageRequest = {
    parent: { uw: input.uw, version: base.snapshot.spec.version },
    accepted: { own: accepted.ref, metadata: head.source },
    inheritedOwnSpecRefs: base.inheritedOwnSpecRefs,
    criteria: base.snapshot.spec.criteria,
    children: base.children.map((child) => ({
      scope: child.scope,
      specVersion: child.specVersion,
      tier: child.tier,
      criteria: child.snapshot.spec.criteria,
    })),
  }
  return resolveCoverage(input, framing, accepted, mandate, input.read.observation, basis)
}
