import type { DecodedHistory } from './history-schema.ts'
import { sameRef } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { UwResult } from './uw-diagnostics.ts'
import type { AcceptedSpecStep } from './workflow-accepted-spec-types.ts'
import { bindExternalRef, historyFor } from './workflow-control.ts'

/** Locate the actual persisted metadata for an already-authenticated accepted step. */
export function acceptedMetadataOwner(
  step: AcceptedSpecStep,
  histories: readonly DecodedHistory[],
): UwResult<{ record: ExternalRecordRef; selector: string }> {
  const failure = (message: string): UwResult<never> => ({
    ok: false,
    diagnostics: [
      { code: 'accepted-metadata-unbound', message, location: { kind: 'record', ref: step.source }, related: [] },
    ],
  })
  const home = historyFor(step.source.scope, histories)
  if (home === null || !home.source.complete)
    return failure('Accepted metadata source history is missing or incomplete')
  const source = bindExternalRef(step.source, home)
  if (!source.ok) return failure('Accepted metadata source cannot be authenticated')
  if (step.kind === 'mandate') {
    if (source.value.kind !== 'mandate' || source.value.payload.ownSpec.version !== step.version)
      return failure('Mandate metadata does not match accepted step')
    return { ok: true, value: { record: step.source, selector: '/payload' } }
  }
  if (step.kind === 'editorial') {
    if (
      source.value.kind !== 'action-receipt' ||
      source.value.payload.action !== 'assess-spec' ||
      source.value.payload.phase !== 'result' ||
      source.value.payload.exactInputs.proposed.snapshot.spec.version !== step.to
    )
      return failure('Editorial metadata does not match accepted assessment')
    return { ok: true, value: { record: step.source, selector: '/payload/exactInputs/proposed' } }
  }
  if (
    source.value.kind !== 'operator-control' ||
    source.value.payload.control !== 'accept-material' ||
    !sameRef(source.value.payload.assessment, step.assessment) ||
    source.value.payload.specVersion !== step.to ||
    source.value.payload.proposalDigest !== step.proposalDigest
  )
    return failure('Material metadata does not match accepted control')
  if (source.value.payload.authorization.kind === 'cause-creation')
    return { ok: true, value: { record: step.source, selector: '/payload/authorization/boundState' } }
  return directMaterialMetadata(step, histories, failure)
}

function directMaterialMetadata(
  step: Extract<AcceptedSpecStep, { kind: 'accept-material' }>,
  histories: readonly DecodedHistory[],
  failure: (message: string) => UwResult<never>,
): UwResult<{ record: ExternalRecordRef; selector: string }> {
  const assessmentHistory = historyFor(step.assessment.scope, histories)
  if (assessmentHistory === null || !assessmentHistory.source.complete)
    return failure('Material assessment history is missing')
  const assessment = bindExternalRef(step.assessment, assessmentHistory)
  if (
    !assessment.ok ||
    assessment.value.kind !== 'action-receipt' ||
    assessment.value.payload.action !== 'assess-spec' ||
    assessment.value.payload.phase !== 'result' ||
    assessment.value.payload.exactInputs.proposed.snapshot.spec.version !== step.to
  )
    return failure('Material assessment metadata is not authenticated')
  return { ok: true, value: { record: step.assessment, selector: '/payload/exactInputs/proposed' } }
}
