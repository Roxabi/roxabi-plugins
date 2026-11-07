import type { DecodedHistory } from './history-schema.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { AcceptedOwnSpec, AcceptedSpecResult } from './workflow-accepted-spec-types.ts'
import { validateComposedMaterialAuthorization } from './workflow-composed-material.ts'
import { bindExternalRef, type ControlRecord, historyFor, workflowOperationProblem } from './workflow-control.ts'
import { type ConcreteAcceptedState, concreteAcceptedStateSchema } from './workflow-mandate-schema.ts'
import { type SpecAssessment, specAssessmentSchema } from './workflow-output-schema.ts'
import {
  type AssessResultRecord,
  type MaterialAcceptanceProposal,
  materialAcceptanceDigest,
  mechanicalSpecDelta,
  requiresMaterialAcceptance,
  sameAssessedState,
  sameMechanicalDelta,
  specChainFailure,
} from './workflow-spec-assessment.ts'
import { authenticatedAssessResult } from './workflow-spec-authentication-chain.ts'

type SpecChainFailure = Extract<AcceptedSpecResult, { ok: false }>
export type MaterialControl = ControlRecord & {
  payload: Extract<ControlRecord['payload'], { control: 'accept-material' }>
}
type MaterialContinuation =
  | { ok: true; assessment: AssessResultRecord; state: ConcreteAcceptedState }
  | { ok: false; result: SpecChainFailure }

function bindingFailure(diagnostics: SpecChainFailure['evidence']): SpecChainFailure {
  const code = diagnostics[0]?.code
  return {
    ok: false,
    reason:
      code === 'conflict' || code === 'ambiguous'
        ? 'ambiguous'
        : code === 'missing-history'
          ? 'missing-history'
          : 'incomplete',
    evidence: diagnostics,
  }
}

function authenticateMaterialAssessment(
  material: MaterialControl,
  histories: readonly DecodedHistory[],
  mandateRef: ExternalRecordRef,
): { ok: true; record: AssessResultRecord; assessment: SpecAssessment } | SpecChainFailure {
  const assessmentHistory = historyFor(material.payload.assessment.scope, histories)
  if (assessmentHistory === null) return specChainFailure('missing-history', 'Spec assessment history is missing')
  const problem = workflowOperationProblem(assessmentHistory)
  if (problem === 'ambiguous') return specChainFailure('ambiguous', 'Spec assessment history conflicts')
  if (problem === 'unconfirmed' || problem === 'incomplete')
    return specChainFailure('incomplete', 'Spec assessment history is not confirmed', problem)
  const bound = bindExternalRef(material.payload.assessment, assessmentHistory)
  if (!bound.ok) return bindingFailure(bound.diagnostics)
  const authenticated = authenticatedAssessResult(bound.value, histories, mandateRef)
  if (!authenticated.ok) return authenticated
  const parsed = specAssessmentSchema.safeParse(authenticated.record.payload.structured)
  if (!parsed.success) return specChainFailure('incomplete', 'Applicable spec assessment is malformed')
  return { ok: true, record: authenticated.record, assessment: parsed.data }
}

function authorizedMaterialState(
  material: MaterialControl,
  proposal: MaterialAcceptanceProposal,
  histories: readonly DecodedHistory[],
): { ok: true; state: ConcreteAcceptedState } | { ok: false; result: SpecChainFailure } {
  const authorization = material.payload.authorization
  if (authorization.kind === 'cause-creation') {
    const result = validateComposedMaterialAuthorization({
      proposal,
      authorization,
      confirmation: material.payload.confirmation,
      histories,
    })
    if (!result.ok)
      return {
        ok: false,
        result: specChainFailure('material-spec', result.diagnostics.map((item) => item.message).join('; ')),
      }
    return { ok: true, state: result.value }
  }
  const state = concreteAcceptedStateSchema.safeParse(proposal.exactInputs.proposed)
  if (!state.success)
    return {
      ok: false,
      result: specChainFailure('material-spec', 'Direct acceptance cannot bind a created child slot'),
    }
  return { ok: true, state: state.data }
}

export function materialContinuation(
  material: MaterialControl,
  histories: readonly DecodedHistory[],
  mandateRef: ExternalRecordRef,
  predecessor: ExternalRecordRef,
  accepted: AcceptedOwnSpec,
  deferCompatibility: (record: AssessResultRecord, assessment: SpecAssessment, refusal?: SpecChainFailure) => void,
): MaterialContinuation {
  const authenticated = authenticateMaterialAssessment(material, histories, mandateRef)
  if (!authenticated.ok) return { ok: false, result: authenticated }
  const assessment = authenticated.record
  const parsed = authenticated.assessment
  const exact = assessment.payload.exactInputs
  if (parsed.compatibility.state !== 'consistent') {
    const result = specChainFailure('material-spec', `Constraint compatibility is ${parsed.compatibility.state}`)
    deferCompatibility(assessment, parsed, result)
    return { ok: false, result }
  }
  deferCompatibility(assessment, parsed)
  if (
    !sameAssessedState(exact.accepted, {
      ref: accepted.ref,
      snapshot: accepted.snapshot,
      tier: accepted.tier,
      children: accepted.children,
      inheritedOwnSpecRefs: accepted.inheritedOwnSpecRefs,
      coverage: accepted.coverage,
    })
  )
    return {
      ok: false,
      result: specChainFailure('material-spec', 'Material assessment does not continue the accepted Spec'),
    }
  const mechanical = mechanicalSpecDelta(exact.accepted, exact.proposed)
  if (!sameMechanicalDelta(mechanical, exact.mechanical))
    return { ok: false, result: specChainFailure('incomplete', 'Material assessment mechanical delta is inconsistent') }
  if (!requiresMaterialAcceptance(mechanical, parsed.classification))
    return {
      ok: false,
      result: specChainFailure('material-spec', 'Material assessment does not require material acceptance'),
    }
  const proposal: MaterialAcceptanceProposal = {
    format: 'omp-build-material-acceptance/2',
    operationId: material.operationId,
    uw: accepted.ref.uw,
    mandate: mandateRef,
    predecessor,
    assessment: material.payload.assessment,
    classification: parsed.classification,
    exactInputs: exact,
  }
  if (
    material.payload.specVersion !== exact.proposed.snapshot.spec.version ||
    material.payload.proposalDigest !== materialAcceptanceDigest(proposal) ||
    (material.payload.authorization.kind === 'direct' &&
      (material.payload.confirmation.operationId !== proposal.operationId ||
        material.payload.confirmation.proposalDigest !== material.payload.proposalDigest)) ||
    JSON.stringify(material.payload.identityDelta.retired) !== JSON.stringify(mechanical.removed)
  )
    return {
      ok: false,
      result: specChainFailure('material-spec', 'Material acceptance does not bind the exact proposal'),
    }
  const state = authorizedMaterialState(material, proposal, histories)
  if (!state.ok) return state
  return { ok: true, assessment, state: state.state }
}
