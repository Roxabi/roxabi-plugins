import type { DecodedHistory } from './history-schema.ts'
import { buildRecord } from './record-construction.ts'
import { diagnostic, equalScope, fail, sameRef } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { CanonicalRecord } from './record-schema.ts'
import { identifierSchema, type Scope } from './record-values.ts'
import type { Result } from './result.ts'
import type { OperatorConfirmationEvidence } from './uw-identity-schema.ts'
import { resolveAcceptedSpec } from './workflow-accepted-spec.ts'
import { type MandateRecord, mandateScope, recordsOf } from './workflow-control.ts'
import { specAssessmentSchema } from './workflow-output-schema.ts'
import type { AssessSpecExact } from './workflow-receipt-schema.ts'
import {
  type AssessmentClassification,
  type AssessResultRecord,
  isAssessResult,
  type MaterialAcceptanceProposal,
  materialAcceptanceDigest,
  mechanicalSpecDelta,
  type PreparedMaterialAcceptance,
  requiresMaterialAcceptance,
  sameAssessedState,
  sameCurrentAssessedState,
  sameMechanicalDelta,
} from './workflow-spec-assessment.ts'
import { receiptRef } from './workflow-spec-authentication.ts'
import { authenticatedAssessResult } from './workflow-spec-authentication-chain.ts'

export type MaterialAcceptanceInput = {
  uw: Scope
  operationId: string
  histories: readonly DecodedHistory[]
  mandate: MandateRecord
  currentProposed: AssessSpecExact['proposed']
  identityAllocations: readonly ExternalRecordRef[]
}

type Selection = {
  proposal: MaterialAcceptanceProposal
}

function sameRefs(left: readonly ExternalRecordRef[], right: readonly ExternalRecordRef[]): boolean {
  return (
    left.length === right.length &&
    left.every((ref, index) => {
      const candidate = right[index]
      return candidate !== undefined && sameRef(ref, candidate)
    })
  )
}

function sameProposed(left: AssessSpecExact['proposed'], right: AssessSpecExact['proposed'], pinned: boolean): boolean {
  return pinned ? JSON.stringify(left) === JSON.stringify(right) : sameCurrentAssessedState(left, right)
}

function materialFailure(code: string, message: string): Result<never> {
  return fail([diagnostic(code, message)])
}

type CandidateOutcome =
  | { status: 'candidate'; record: AssessResultRecord; classification: AssessmentClassification }
  | { status: 'stale' }

function isCurrentCandidate(
  record: CanonicalRecord,
  input: MaterialAcceptanceInput,
  mandate: ExternalRecordRef,
  requiredAssessment?: ExternalRecordRef,
): record is AssessResultRecord {
  if (!isAssessResult(record) || !sameRef(record.payload.mandate, mandate)) return false
  if (requiredAssessment !== undefined && !sameRef(receiptRef(record), requiredAssessment)) return false
  return (
    sameProposed(record.payload.exactInputs.proposed, input.currentProposed, requiredAssessment !== undefined) &&
    sameRefs(record.payload.exactInputs.identityAllocations, input.identityAllocations)
  )
}

function evaluateCandidate(
  record: AssessResultRecord,
  histories: readonly DecodedHistory[],
  mandate: ExternalRecordRef,
  accepted: AssessSpecExact['accepted'],
): Result<CandidateOutcome> {
  if (!specAssessmentSchema.safeParse(record.payload.structured).success)
    return materialFailure('material-assessment-malformed', 'Material assessment output is malformed')
  const authenticated = authenticatedAssessResult(record, histories, mandate)
  if (!authenticated.ok) return fail(authenticated.evidence)
  const exact = record.payload.exactInputs
  if (!sameAssessedState(exact.accepted, accepted)) return { ok: true, value: { status: 'stale' } }
  const mechanical = mechanicalSpecDelta(exact.accepted, exact.proposed)
  if (!sameMechanicalDelta(mechanical, exact.mechanical))
    return materialFailure('material-assessment-malformed', 'Material assessment mechanical delta is inconsistent')
  const classification = specAssessmentSchema.parse(record.payload.structured).classification
  if (!requiresMaterialAcceptance(mechanical, classification))
    return materialFailure('material-assessment-not-material', 'Assessment does not require material acceptance')
  return { ok: true, value: { status: 'candidate', record: authenticated.record, classification } }
}

function matchingAssessments(
  records: readonly CanonicalRecord[],
  input: MaterialAcceptanceInput,
  mandate: ExternalRecordRef,
  accepted: AssessSpecExact['accepted'],
  requiredAssessment?: ExternalRecordRef,
): Result<{
  candidates: Array<{ record: AssessResultRecord; classification: AssessmentClassification }>
  stale: boolean
}> {
  const candidates: Array<{ record: AssessResultRecord; classification: AssessmentClassification }> = []
  let stale = false
  for (const record of records) {
    if (!isCurrentCandidate(record, input, mandate, requiredAssessment)) continue
    const outcome = evaluateCandidate(record, input.histories, mandate, accepted)
    if (!outcome.ok) return outcome
    if (outcome.value.status === 'stale') stale = true
    if (outcome.value.status === 'candidate') candidates.push(outcome.value)
  }
  return { ok: true, value: { candidates, stale } }
}

function selectMaterialAcceptance(
  input: MaterialAcceptanceInput,
  requiredAssessment?: ExternalRecordRef,
): Result<Selection> {
  if (!identifierSchema.safeParse(input.operationId).success)
    return materialFailure('material-operation-invalid', 'Material acceptance operation ID is invalid')
  const accepted = resolveAcceptedSpec(input.mandate, input.histories)
  if (!accepted.ok) return fail(accepted.evidence)
  if (!equalScope(input.uw, accepted.spec.ref.uw))
    return materialFailure('material-uw-mismatch', 'Material acceptance UW does not match the accepted own Spec')

  const scope = mandateScope(input.mandate)
  const home = input.histories.find((history) => equalScope(history.source.scope, scope))
  if (home === undefined) return materialFailure('missing-history', 'Mandate history is missing')
  const records = recordsOf(home)
  if (records.some((record) => record.operationId === input.operationId))
    return materialFailure(
      'material-operation-conflict',
      'Material acceptance operation ID is already present in mandate history',
    )
  const mandate: ExternalRecordRef = { scope, recordId: input.mandate.recordId, kind: 'mandate' }
  const acceptedState: AssessSpecExact['accepted'] = {
    ref: accepted.spec.ref,
    snapshot: accepted.spec.snapshot,
    tier: accepted.spec.tier,
    children: accepted.spec.children,
  }
  const matches = matchingAssessments(records, input, mandate, acceptedState, requiredAssessment)
  if (!matches.ok) return matches
  const { candidates, stale } = matches.value

  if (candidates.length > 1)
    return materialFailure(
      'material-assessment-ambiguous',
      'Multiple authenticated material assessments match the current proposal',
    )
  const assessment = candidates[0]
  if (assessment === undefined)
    return materialFailure(
      stale ? 'material-assessment-stale' : 'material-assessment-missing',
      stale
        ? 'Material assessment continues a stale accepted Spec'
        : 'No authenticated material assessment matches the current proposal',
    )

  const proposal: MaterialAcceptanceProposal = {
    format: 'omp-build-material-acceptance/1',
    operationId: input.operationId,
    uw: accepted.spec.ref.uw,
    mandate,
    predecessor: accepted.spec.ref.sourceAccepted,
    assessment: receiptRef(assessment.record),
    classification: assessment.classification,
    exactInputs: assessment.record.payload.exactInputs,
  }
  return { ok: true, value: { proposal } }
}

export function prepareMaterialAcceptance(input: MaterialAcceptanceInput): Result<PreparedMaterialAcceptance> {
  const selected = selectMaterialAcceptance(input)
  if (!selected.ok) return selected
  return {
    ok: true,
    value: {
      proposal: selected.value.proposal,
      digest: materialAcceptanceDigest(selected.value.proposal),
    },
  }
}

export function recheckMaterialAcceptance(input: {
  prepared: PreparedMaterialAcceptance
  histories: readonly DecodedHistory[]
  mandate: MandateRecord
}): Result<PreparedMaterialAcceptance> {
  const { proposal, digest } = input.prepared
  if (proposal.format !== 'omp-build-material-acceptance/1' || digest !== materialAcceptanceDigest(proposal))
    return materialFailure('material-proposal-invalid', 'Prepared material proposal digest is invalid')
  const selected = selectMaterialAcceptance(
    {
      uw: proposal.uw,
      operationId: proposal.operationId,
      histories: input.histories,
      mandate: input.mandate,
      currentProposed: proposal.exactInputs.proposed,
      identityAllocations: proposal.exactInputs.identityAllocations,
    },
    proposal.assessment,
  )
  if (!selected.ok) return selected
  if (JSON.stringify(selected.value.proposal) !== JSON.stringify(proposal))
    return materialFailure(
      'material-proposal-stale',
      'Material proposal no longer binds the current accepted assessment',
    )
  return { ok: true, value: input.prepared }
}

export function buildMaterialAcceptanceControl(
  prepared: PreparedMaterialAcceptance,
  confirmation: OperatorConfirmationEvidence,
): Result<Extract<CanonicalRecord, { kind: 'operator-control' }>> {
  const { proposal, digest } = prepared
  if (proposal.format !== 'omp-build-material-acceptance/1' || digest !== materialAcceptanceDigest(proposal))
    return materialFailure('material-proposal-invalid', 'Prepared material proposal digest is invalid')
  const mechanical = mechanicalSpecDelta(proposal.exactInputs.accepted, proposal.exactInputs.proposed)
  if (
    !sameMechanicalDelta(mechanical, proposal.exactInputs.mechanical) ||
    !requiresMaterialAcceptance(mechanical, proposal.classification)
  )
    return materialFailure('material-proposal-invalid', 'Prepared material proposal is not an authenticated change')
  if (
    !equalScope(proposal.uw, proposal.exactInputs.accepted.ref.uw) ||
    !sameRef(proposal.predecessor, proposal.exactInputs.accepted.ref.sourceAccepted) ||
    proposal.mandate.kind !== 'mandate' ||
    proposal.assessment.kind !== 'action-receipt'
  )
    return materialFailure('material-proposal-invalid', 'Prepared material proposal references are inconsistent')
  if (confirmation.operationId !== proposal.operationId || confirmation.proposalDigest !== digest)
    return materialFailure(
      'material-confirmation-mismatch',
      'Operator confirmation does not bind the prepared material proposal',
    )
  return buildRecord({
    repository: proposal.mandate.scope.repository,
    target: proposal.mandate.scope.target,
    version: 1,
    recordId: proposal.operationId,
    runId: proposal.operationId,
    operationId: proposal.operationId,
    kind: 'operator-control',
    payload: {
      control: 'accept-material',
      controlId: proposal.operationId,
      mandate: proposal.mandate,
      predecessor: proposal.predecessor,
      assessment: proposal.assessment,
      specVersion: proposal.exactInputs.proposed.snapshot.spec.version,
      proposalDigest: digest,
      confirmation,
      identityDelta: { retired: [...proposal.exactInputs.mechanical.removed] },
    },
  })
}
