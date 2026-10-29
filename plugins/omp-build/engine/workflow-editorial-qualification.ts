import type { DecodedHistory } from './history-schema.ts'
import { sameRef } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { AcceptedOwnSpec, AcceptedSpecResult } from './workflow-accepted-spec-types.ts'
import { workflowContextNegative } from './workflow-context-terminal.ts'
import { specAssessmentSchema } from './workflow-output-schema.ts'
import {
  type AssessResultRecord,
  isMechanical,
  mechanicalSpecDelta,
  sameAssessedState,
  sameMechanicalDelta,
  specChainFailure,
} from './workflow-spec-assessment.ts'
import { authenticatedAssessResult } from './workflow-spec-authentication-chain.ts'

type SpecChainFailure = Extract<AcceptedSpecResult, { ok: false }>
export type EditorialQualification =
  | { status: 'irrelevant' }
  | { status: 'material' }
  | { status: 'editorial'; record: AssessResultRecord }
  | { status: 'refused'; result: SpecChainFailure }

type EditorialQualificationInput = {
  histories: readonly DecodedHistory[]
  mandateRef: ExternalRecordRef
  applied: ReadonlySet<string>
  accepted: AcceptedOwnSpec
}

function applicableAssessment(
  record: CanonicalRecord,
  mandateRef: ExternalRecordRef,
  applied: ReadonlySet<string>,
  accepted: AcceptedOwnSpec,
): record is AssessResultRecord {
  return (
    record.kind === 'action-receipt' &&
    record.payload.action === 'assess-spec' &&
    record.payload.phase === 'result' &&
    sameRef(record.payload.mandate, mandateRef) &&
    !applied.has(record.recordId) &&
    sameAssessedState(record.payload.exactInputs.accepted, {
      ref: accepted.ref,
      snapshot: accepted.snapshot,
      tier: accepted.tier,
      children: accepted.children,
    })
  )
}

export function qualifyEditorialCandidate(
  record: CanonicalRecord,
  input: EditorialQualificationInput,
): EditorialQualification {
  if (!applicableAssessment(record, input.mandateRef, input.applied, input.accepted)) return { status: 'irrelevant' }
  const authenticated = authenticatedAssessResult(record, input.histories, input.mandateRef)
  if (!authenticated.ok) return { status: 'refused', result: authenticated }
  if (workflowContextNegative(authenticated.record)) return { status: 'irrelevant' }
  const parsed = specAssessmentSchema.safeParse(authenticated.record.payload.structured)
  if (!parsed.success)
    return { status: 'refused', result: specChainFailure('incomplete', 'Applicable spec assessment is malformed') }
  const exact = authenticated.record.payload.exactInputs
  const mechanical = mechanicalSpecDelta(exact.accepted, exact.proposed)
  if (!sameMechanicalDelta(mechanical, exact.mechanical))
    return {
      status: 'refused',
      result: specChainFailure('incomplete', 'Spec assessment mechanical delta does not match its exact states'),
    }
  if (isMechanical(mechanical) || parsed.data.classification !== 'editorial') return { status: 'material' }
  return { status: 'editorial', record: authenticated.record }
}
