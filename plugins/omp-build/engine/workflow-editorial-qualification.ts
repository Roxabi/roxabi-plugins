import type { DecodedHistory } from './history-schema.ts'
import { specDigest } from './record-digests.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { AcceptedSpecResult } from './workflow-accepted-spec.ts'
import { specAssessmentSchema } from './workflow-output-schema.ts'
import { type AssessResultRecord, specChainFailure } from './workflow-spec-authentication.ts'
import { authenticatedAssessResult } from './workflow-spec-authentication-chain.ts'
import { sameRef } from './workflow-support.ts'

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
  body: string
  digest: string
}

function applicableAssessment(
  record: CanonicalRecord,
  mandateRef: ExternalRecordRef,
  applied: ReadonlySet<string>,
  digest: string,
): record is AssessResultRecord {
  return (
    record.kind === 'action-receipt' &&
    record.payload.action === 'assess-spec' &&
    record.payload.phase === 'result' &&
    sameRef(record.payload.mandate, mandateRef) &&
    !applied.has(record.recordId) &&
    record.payload.exactInputs.acceptedDigest === digest
  )
}

function continuousInputs(record: AssessResultRecord, body: string, digest: string): boolean {
  const inputs = record.payload.exactInputs
  return (
    inputs.acceptedBody === body &&
    inputs.acceptedDigest === digest &&
    specDigest(inputs.acceptedBody) === inputs.acceptedDigest &&
    specDigest(inputs.currentBody) === inputs.currentDigest
  )
}

export function qualifyEditorialCandidate(
  record: CanonicalRecord,
  input: EditorialQualificationInput,
): EditorialQualification {
  if (!applicableAssessment(record, input.mandateRef, input.applied, input.digest)) return { status: 'irrelevant' }
  const parsed = specAssessmentSchema.safeParse(record.payload.structured)
  if (!parsed.success)
    return { status: 'refused', result: specChainFailure('incomplete', 'Applicable spec assessment is malformed') }
  if (parsed.data.classification === 'unknown')
    return { status: 'refused', result: specChainFailure('ambiguous', 'Applicable spec assessment is unknown') }
  if (parsed.data.classification !== 'editorial') return { status: 'material' }
  const authenticated = authenticatedAssessResult(record, input.histories, input.mandateRef)
  if (!authenticated.ok) return { status: 'refused', result: authenticated }
  if (!continuousInputs(authenticated.record, input.body, input.digest)) {
    return {
      status: 'refused',
      result: specChainFailure('material-spec', 'Editorial assessment does not continue the accepted spec'),
    }
  }
  return { status: 'editorial', record: authenticated.record }
}
