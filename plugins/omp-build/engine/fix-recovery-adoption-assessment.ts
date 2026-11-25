import { canonicalValueDigest, samePluginPin } from './action-input.ts'
import type { RecordInputRef } from './action-input-refs.ts'
import { assessCauseDispositions, assessHistoricalCauseDispositions } from './cause-assessment.ts'
import { decisionCauseCapture } from './cause-capture-authentication.ts'
import { readCauseDispositionHeads } from './cause-heads.ts'
import { validateCauseDispositionRecords } from './cause-record-validation.ts'
import { resolveCorrectionRequestBasis } from './correction-request-basis.ts'
import { fixRecoveryDecisionCatalogueRefs, readFixRecoveryCatalogues } from './fix-recovery-catalogues.ts'
import type { FixRecoveryProposal } from './fix-recovery-control-schema.ts'
import { selectFixRecoveryDispositionPlan } from './fix-recovery-disposition-plan.ts'
import { hasSpentOrAmbiguousCorrectionEvidence } from './fix-recovery-spent-evidence.ts'
import { authenticateHistoricalActionInputs } from './historical-action-inputs.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Result } from './result.ts'
import type { ReviewClassCatalogues } from './review-class-catalogue.ts'
import type { UwGraphObservation } from './uw-graph.ts'
import { bindExternalRef } from './workflow-control.ts'

type Adoption = Extract<FixRecoveryProposal, { phase: 'adopt-decision' }>
const fail = (detail: string): Result<never> => ({
  ok: false,
  diagnostics: [diagnostic('unconfirmed', `Correction adoption: ${detail}`)],
})

function resolveAdoptionBasis(
  proposal: Adoption,
  histories: readonly DecodedHistory[],
): Result<{
  decision: Extract<CanonicalRecord, { kind: 'decision' }>
  catalogues: ReviewClassCatalogues
  capture: RecordInputRef
}> {
  const request = proposal.target.request.identity
  const decision = proposal.target.decision.identity
  const homes = histories.filter((history) => equalScope(history.source.scope, request.scope))
  const home = homes[0]
  if (homes.length !== 1 || home === undefined || !equalScope(request.scope, decision.scope))
    return fail('request and decision lack one shared source history')
  const requestRecord = bindExternalRef({ scope: request.scope, kind: 'fix-request', recordId: request.recordId }, home)
  const decisionRecord = bindExternalRef({ scope: decision.scope, kind: 'decision', recordId: decision.recordId }, home)
  if (!requestRecord.ok) return requestRecord
  if (!decisionRecord.ok) return decisionRecord
  if (requestRecord.value.kind !== 'fix-request' || decisionRecord.value.kind !== 'decision')
    return fail('request or decision kind does not match its reference')
  const refs = fixRecoveryDecisionCatalogueRefs({ decision: decisionRecord.value, history: home, histories })
  if (!refs.ok) return refs
  const catalogues = readFixRecoveryCatalogues({ observation: proposal.observation, required: refs.value })
  if (!catalogues.ok) return catalogues
  const requestBasis = resolveCorrectionRequestBasis(
    home,
    requestRecord.value,
    decisionRecord.value,
    catalogues.value,
    histories,
  )
  if (!requestBasis.ok) return requestBasis
  const capture = decisionCauseCapture(decisionRecord.value, histories)
  if (!capture.ok) return capture
  return { ok: true, value: { decision: decisionRecord.value, catalogues: catalogues.value, capture: capture.value } }
}

function validateNativePreparation(
  proposal: Adoption,
  decision: Extract<CanonicalRecord, { kind: 'decision' }>,
  executableCauseIds: readonly string[],
  histories: readonly DecodedHistory[],
): Result<true> {
  const observation = proposal.observation
  const first = decision.payload.judgment.causes.find((cause) => executableCauseIds.includes(cause.id))
  if (first === undefined)
    return proposal.nativePreparation.kind === 'no-native-action'
      ? { ok: true, value: true }
      : fail('native preparation exists without an executable cause')
  if (proposal.nativePreparation.kind !== 'prepared' || proposal.nativePreparation.causeId !== first.id)
    return fail('native preparation does not target the first executable cause')
  const valid = authenticateHistoricalActionInputs(proposal.nativePreparation.inputs, histories)
  if (!valid.ok) return valid
  const manifest = valid.value.manifest
  if (manifest.purpose !== 'correction') return fail('native action purpose is not correction')
  if (manifest.spec.kind !== 'accepted') return fail('native action lacks an accepted Spec')
  if (canonicalValueDigest(manifest.spec.effective) !== canonicalValueDigest(observation.authority.accepted))
    return fail('native action accepted Spec differs from observation')
  if (!samePluginPin(manifest.plugin, observation.authority.plugin))
    return fail('native action plugin pin differs from observation')
  if (canonicalValueDigest(manifest.configuration) !== canonicalValueDigest(observation.authority.configuration))
    return fail('native action configuration differs from observation')
  if (manifest.code.head !== observation.pullRequest.candidateGitSHA)
    return fail('native action head differs from observed pull request')
  return { ok: true, value: true }
}
/** Current admission uses the real graph; replay uses the authenticated finite historical cut. */
export function validateRecoveryAdoptionPlan(input: {
  proposal: Adoption
  histories: readonly DecodedHistory[]
  graph?: UwGraphObservation
}): Result<true> {
  const { proposal, histories } = input
  const observation = proposal.observation
  const request = proposal.target.request.identity
  const decision = proposal.target.decision.identity
  if (
    hasSpentOrAmbiguousCorrectionEvidence(
      histories,
      { scope: request.scope, kind: 'fix-request', recordId: request.recordId },
      { scope: decision.scope, kind: 'decision', recordId: decision.recordId },
    )
  )
    return fail('request or decision has spent or ambiguous correction evidence')
  const resolved = resolveAdoptionBasis(proposal, histories)
  if (!resolved.ok) return resolved
  const { decision: decisionRecord, catalogues, capture } = resolved.value
  const source = { kind: 'decision' as const, decision: decisionRecord }
  const context = { original: observation.authority.accepted.own.uw, effective: observation.authority.accepted }
  const records = histories.flatMap((history) =>
    history.operations.flatMap((operation) =>
      operation.authority !== 'foreign' && operation.status === 'complete' && operation.record !== null
        ? [operation.record]
        : [],
    ),
  )
  const invalid = validateCauseDispositionRecords({ records, histories, catalogues })
  if (invalid.length !== 0) return { ok: false, diagnostics: invalid }
  const heads = readCauseDispositionHeads({ uw: context.original, histories, catalogues })
  if (!heads.ok) return heads
  const basis = { context, capture, source, histories, catalogues, adjudications: [] }
  const assessment =
    input.graph === undefined
      ? assessHistoricalCauseDispositions(basis)
      : assessCauseDispositions({ ...basis, graph: input.graph })
  if (!assessment.ok) return assessment
  const plan = selectFixRecoveryDispositionPlan({
    outcomes: assessment.value.outcomes,
    heads: heads.value,
    executableCauseIds: assessment.value.executableCauseIds,
    source,
  })
  if (!plan.ok) return plan
  return validateNativePreparation(proposal, decisionRecord, plan.value.executableCauseIds, histories)
}
