import type { DecodedHistory } from './history-schema.ts'
import { buildRecord } from './record-construction.ts'
import { diagnostic, equalScope, fail, sameRef } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { CanonicalRecord } from './record-schema.ts'
import { identifierSchema, type Scope } from './record-values.ts'
import type { Result } from './result.ts'
import type { OperatorConfirmationEvidence } from './uw-identity-schema.ts'
import { resolveAcceptedSpec } from './workflow-accepted-spec.ts'
import type { AcceptedOwnSpec } from './workflow-accepted-spec-types.ts'
import { classifyAttempts } from './workflow-action-interruption.ts'
import { workflowContextNegative } from './workflow-context-output.ts'
import { workflowContextTerminal } from './workflow-context-terminal.ts'
import { excludedReceipt, type MandateRecord, mandateScope, recordsOf } from './workflow-control.ts'
import { evaluateCandidate } from './workflow-material-assessment.ts'
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
  sameCurrentAssessedState,
  sameMechanicalDelta,
} from './workflow-spec-assessment.ts'
import { receiptRef } from './workflow-spec-authentication.ts'

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

function matchingAssessments(
  records: readonly CanonicalRecord[],
  input: MaterialAcceptanceInput,
  mandate: ExternalRecordRef,
  accepted: AcceptedOwnSpec,
  excluded: ReadonlySet<string>,
  requiredAssessment?: ExternalRecordRef,
): Result<{
  candidates: Array<{ record: AssessResultRecord; classification: AssessmentClassification }>
  stale: boolean
}> {
  const candidates: Array<{ record: AssessResultRecord; classification: AssessmentClassification }> = []
  let stale = false
  for (const record of records) {
    if (!isCurrentCandidate(record, input, mandate, requiredAssessment)) continue
    if (excludedReceipt(record, excluded)) continue
    if (supersededContext(record, input, excluded, requiredAssessment)) continue
    const outcome = evaluateCandidate(record, input.histories, mandate, accepted)
    if (!outcome.ok) return outcome
    if (outcome.value.status === 'stale') stale = true
    if (outcome.value.status === 'candidate') candidates.push(outcome.value)
  }
  return { ok: true, value: { candidates, stale } }
}

function supersededContext(
  record: AssessResultRecord,
  input: MaterialAcceptanceInput,
  excluded: ReadonlySet<string>,
  requiredAssessment?: ExternalRecordRef,
): boolean {
  if (requiredAssessment !== undefined || !workflowContextNegative(record)) return false
  const home = input.histories.find(
    (history) => history.source.scope.repository === record.repository && history.source.scope.target === record.target,
  )
  return home !== undefined && workflowContextTerminal(home, 'assess-spec', undefined, excluded) === 'clear'
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
  const attempts = classifyAttempts({ histories: input.histories, scan: [home], actions: ['assess-spec'] })
  if (!attempts.ok) return attempts
  const matches = matchingAssessments(
    records,
    input,
    mandate,
    accepted.spec,
    attempts.value.excluded,
    requiredAssessment,
  )
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

  const predecessor = accepted.spec.chain.at(-1)
  if (predecessor === undefined)
    return materialFailure('material-proposal-invalid', 'Accepted Spec chain has no predecessor')
  const proposal: MaterialAcceptanceProposal = {
    format: 'omp-build-material-acceptance/2',
    operationId: input.operationId,
    uw: accepted.spec.ref.uw,
    mandate,
    predecessor: predecessor.source,
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
export function prepareMaterialAcceptanceForAssessment(
  input: MaterialAcceptanceInput,
  assessment: ExternalRecordRef,
): Result<PreparedMaterialAcceptance> {
  const selected = selectMaterialAcceptance(input, assessment)
  if (!selected.ok) return selected
  return {
    ok: true,
    value: { proposal: selected.value.proposal, digest: materialAcceptanceDigest(selected.value.proposal) },
  }
}

export function recheckMaterialAcceptance(input: {
  prepared: PreparedMaterialAcceptance
  histories: readonly DecodedHistory[]
  mandate: MandateRecord
}): Result<PreparedMaterialAcceptance> {
  const { proposal, digest } = input.prepared
  if (proposal.format !== 'omp-build-material-acceptance/2' || digest !== materialAcceptanceDigest(proposal))
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
  context: { histories: readonly DecodedHistory[]; mandate: MandateRecord },
): Result<Extract<CanonicalRecord, { kind: 'operator-control' }>> {
  const { proposal, digest } = prepared
  if (proposal.format !== 'omp-build-material-acceptance/2' || digest !== materialAcceptanceDigest(proposal))
    return materialFailure('material-proposal-invalid', 'Prepared material proposal digest is invalid')
  const mechanical = mechanicalSpecDelta(proposal.exactInputs.accepted, proposal.exactInputs.proposed)
  if (
    !sameMechanicalDelta(mechanical, proposal.exactInputs.mechanical) ||
    !requiresMaterialAcceptance(mechanical, proposal.classification)
  )
    return materialFailure('material-proposal-invalid', 'Prepared material proposal is not an authenticated change')
  if (
    !equalScope(proposal.uw, proposal.exactInputs.accepted.ref.uw) ||
    !sameRef(proposal.mandate, {
      scope: mandateScope(context.mandate),
      recordId: context.mandate.recordId,
      kind: 'mandate',
    }) ||
    proposal.mandate.kind !== 'mandate' ||
    proposal.assessment.kind !== 'action-receipt'
  )
    return materialFailure('material-proposal-invalid', 'Prepared material proposal references are inconsistent')
  if (confirmation.operationId !== proposal.operationId || confirmation.proposalDigest !== digest)
    return materialFailure(
      'material-confirmation-mismatch',
      'Operator confirmation does not bind the prepared material proposal',
    )
  const fresh = recheckMaterialAcceptance({ prepared, ...context })
  if (!fresh.ok) return fresh
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
      authorization: { kind: 'direct' },
      confirmation,
      identityDelta: { retired: [...proposal.exactInputs.mechanical.removed] },
    },
  })
}
