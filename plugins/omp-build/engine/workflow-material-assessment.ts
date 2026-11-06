import { canonicalValueDigest } from './canonical-value.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, fail } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { Result } from './result.ts'
import { checkAuthenticatedSpecCompatibility } from './workflow-accepted-spec.ts'
import type { AcceptedOwnSpec } from './workflow-accepted-spec-types.ts'
import { capturedAssessmentSourcesMatch, capturedChildOwnSources } from './workflow-assessment-child-sources.ts'
import { bindExternalRef, historyFor } from './workflow-control.ts'
import { specAssessmentSchema } from './workflow-output-schema.ts'
import {
  type AssessmentClassification,
  type AssessResultRecord,
  mechanicalSpecDelta,
  requiresMaterialAcceptance,
  sameAssessedState,
  sameMechanicalDelta,
} from './workflow-spec-assessment.ts'
import { authenticatedAssessResult } from './workflow-spec-authentication-chain.ts'

type CandidateOutcome =
  | { status: 'candidate'; record: AssessResultRecord; classification: AssessmentClassification }
  | { status: 'stale' }

function materialFailure(code: string, message: string): Result<never> {
  return fail([diagnostic(code, message)])
}

function candidateSourcesCurrent(
  record: AssessResultRecord,
  accepted: AcceptedOwnSpec,
  histories: readonly DecodedHistory[],
): Result<boolean> {
  const exact = record.payload.exactInputs
  if (
    !sameAssessedState(exact.accepted, {
      ref: accepted.ref,
      snapshot: accepted.snapshot,
      tier: accepted.tier,
      children: accepted.children,
      inheritedOwnSpecRefs: accepted.inheritedOwnSpecRefs,
      coverage: accepted.coverage,
    }) ||
    !capturedAssessmentSourcesMatch(
      { childOwnSources: [], sourceRefs: accepted.sourceRefs },
      record.payload.inputs.manifest.acceptedSources,
      histories,
    )
  )
    return { ok: true, value: false }
  const currentChildren = capturedChildOwnSources(exact.accepted, exact.proposed, histories, exact.attachedChildren)
  if (currentChildren === null)
    return materialFailure('material-child-sources-unavailable', 'Current child own sources cannot be authenticated')
  return {
    ok: true,
    value:
      canonicalValueDigest(currentChildren.childOwnSources) === canonicalValueDigest(exact.childOwnSources) &&
      capturedAssessmentSourcesMatch(currentChildren, record.payload.inputs.manifest.acceptedSources, histories),
  }
}

export function evaluateCandidate(
  record: AssessResultRecord,
  histories: readonly DecodedHistory[],
  mandate: ExternalRecordRef,
  accepted: AcceptedOwnSpec,
): Result<CandidateOutcome> {
  if (!specAssessmentSchema.safeParse(record.payload.structured).success)
    return materialFailure('material-assessment-malformed', 'Material assessment output is malformed')
  if (specAssessmentSchema.parse(record.payload.structured).compatibility.state !== 'consistent')
    return materialFailure(
      'constraint-compatibility-unresolved',
      'Constraint compatibility must be consistent before material acceptance',
    )
  const authenticated = authenticatedAssessResult(record, histories, mandate)
  if (!authenticated.ok) return fail(authenticated.evidence)
  const mandateHistory = historyFor(mandate.scope, histories)
  const mandateRecord = mandateHistory === null ? null : bindExternalRef(mandate, mandateHistory)
  if (mandateRecord === null || !mandateRecord.ok || mandateRecord.value.kind !== 'mandate')
    return materialFailure('constraint-compatibility-unresolved', 'Assessment mandate is not authenticated')
  const compatibilityProblem = checkAuthenticatedSpecCompatibility(
    authenticated.record,
    specAssessmentSchema.parse(authenticated.record.payload.structured),
    histories,
    mandateRecord.value,
  )
  if (compatibilityProblem !== null) return materialFailure('constraint-compatibility-unresolved', compatibilityProblem)
  const sources = candidateSourcesCurrent(record, accepted, histories)
  if (!sources.ok) return sources
  if (!sources.value) return { ok: true, value: { status: 'stale' } }
  const exact = record.payload.exactInputs
  const mechanical = mechanicalSpecDelta(exact.accepted, exact.proposed)
  if (!sameMechanicalDelta(mechanical, exact.mechanical))
    return materialFailure('material-assessment-malformed', 'Material assessment mechanical delta is inconsistent')
  const classification = specAssessmentSchema.parse(record.payload.structured).classification
  if (!requiresMaterialAcceptance(mechanical, classification))
    return materialFailure('material-assessment-not-material', 'Assessment does not require material acceptance')
  return { ok: true, value: { status: 'candidate', record: authenticated.record, classification } }
}
