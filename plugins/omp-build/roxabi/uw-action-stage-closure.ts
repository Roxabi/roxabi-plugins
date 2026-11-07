import { canonicalValueDigest } from '../dist/contracts.js'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { Result } from '../engine/result.ts'
import type { ReviewClassCatalogues } from '../engine/review-class-catalogue.ts'
import type { AcceptedOwnSpec } from '../engine/workflow-accepted-spec-types.ts'
import type { RecordInputRef, UwActionRequest } from './uw-action-contract.ts'
import { pinAcceptedSources } from './uw-action-observe.ts'
import { actionFailure } from './uw-action-result.ts'
import type { UwRead } from './uw-contract.ts'
import { priorCorrectionContribution } from './uw-correction-stage-contribution.ts'
import { priorCorrectionDecision } from './uw-correction-stage-decision.ts'

function priorCorrectionStage(
  ref: RecordInputRef,
  request: UwActionRequest,
  histories: readonly DecodedHistory[],
  catalogues: ReviewClassCatalogues,
): Result<boolean> {
  const decision = priorCorrectionDecision(ref, request, histories, catalogues)
  if (!decision.ok || decision.value) return decision
  return priorCorrectionContribution(ref, request, histories, catalogues)
}

export type IntegrationStageObservation = {
  read: UwRead
  accepted: AcceptedOwnSpec
  acceptedSources: readonly RecordInputRef[]
}

export function integrationProofInputs(read: UwRead): Result<{
  acceptedSources: readonly RecordInputRef[]
  childSources: readonly RecordInputRef[]
  stageSources: readonly RecordInputRef[]
}> {
  if (
    read.observation.status !== 'complete' ||
    !read.admission.deliverable.ok ||
    read.accepted.status !== 'accepted' ||
    read.accepted.value.children.length === 0
  )
    return actionFailure('self-output', 'Integration requires an authenticated parent observation')
  const accepted = read.accepted.value
  const histories = read.observation.histories
  const parent = pinAcceptedSources(histories, [
    ...accepted.sourceRefs,
    ...[accepted.ref, ...accepted.inheritedOwnSpecRefs].map((ref) => ref.sourceAccepted),
  ])
  if (!parent.ok) return parent
  const refs = []
  for (const child of accepted.children) {
    const matches = [...read.completion.completions.values()].filter(
      (item) => item.uw.repository === child.scope.repository && item.uw.target === child.scope.target,
    )
    const completion = matches[0]
    if (matches.length !== 1 || completion?.state !== 'complete' || completion.spec.version !== child.specVersion)
      return actionFailure('self-output', 'Integration child completion is not current and authenticated')
    refs.push(...completion.sources)
  }
  const children = pinAcceptedSources(histories, refs)
  if (!children.ok) return children
  if (children.value.length === 0) return actionFailure('self-output', 'Integration child proof is empty')
  const acceptedPins = new Set(parent.value.map((pin) => canonicalValueDigest(pin)))
  return {
    ok: true,
    value: {
      acceptedSources: parent.value,
      childSources: children.value,
      stageSources: children.value.filter((pin) => !acceptedPins.has(canonicalValueDigest(pin))),
    },
  }
}

function integrationStageSources(
  request: UwActionRequest,
  histories: readonly DecodedHistory[],
  catalogues: ReviewClassCatalogues,
  integration: IntegrationStageObservation | undefined,
): Result<readonly RecordInputRef[]> {
  if (integration === undefined || request.subject.kind !== 'uw')
    return actionFailure('self-output', 'Integration requires an authenticated parent observation')
  const { read, accepted, acceptedSources } = integration
  if (
    read.observation.status !== 'complete' ||
    read.observation.histories !== histories ||
    read.observation.catalogues !== catalogues ||
    read.accepted.status !== 'accepted' ||
    canonicalValueDigest(read.accepted.value) !== canonicalValueDigest(accepted) ||
    read.uw.repository !== request.subject.uw.repository ||
    read.uw.target !== request.subject.uw.target
  )
    return actionFailure('self-output', 'Integration parent authority or observation changed')
  const projected = integrationProofInputs(read)
  if (!projected.ok) return projected
  if (canonicalValueDigest(acceptedSources) !== canonicalValueDigest(projected.value.acceptedSources))
    return actionFailure('self-output', 'Integration accepted sources differ from the observed parent')
  const expected = new Set(projected.value.stageSources.map((ref) => canonicalValueDigest(ref)))
  if (
    request.stageSources.length !== expected.size ||
    request.stageSources.some((ref) => !expected.has(canonicalValueDigest(ref))) ||
    new Set(request.stageSources.map((ref) => canonicalValueDigest(ref))).size !== expected.size
  )
    return actionFailure('self-output', 'Integration stage sources differ from the observed child completion proofs')
  return { ok: true, value: projected.value.childSources }
}

function refuseIntegrationStage(
  request: UwActionRequest,
  outputs: ReadonlySet<string>,
  histories: readonly DecodedHistory[],
  catalogues: ReviewClassCatalogues,
  integration: IntegrationStageObservation | undefined,
): Result<true> {
  const verified = integrationStageSources(request, histories, catalogues, integration)
  if (
    verified.ok &&
    verified.value.some(({ record }) =>
      outputs.has([record.scope.repository, record.scope.target, record.kind, record.recordId].join('\0')),
    )
  )
    return actionFailure('self-output', 'Integration stage source is a current root output')
  return verified.ok ? { ok: true, value: true } : verified
}

export function refuseOutsideStage(
  request: UwActionRequest,
  outputs: ReadonlySet<string>,
  histories: readonly DecodedHistory[],
  catalogues: ReviewClassCatalogues,
  integration?: IntegrationStageObservation,
): Result<true> {
  if (request.purpose === 'integrate')
    return refuseIntegrationStage(request, outputs, histories, catalogues, integration)
  for (const ref of request.stageSources) {
    const { scope, kind, recordId } = ref.record
    const owned = outputs.has([scope.repository, scope.target, kind, recordId].join('\0'))
    if (request.purpose !== 'correction') {
      if (!owned) return actionFailure('self-output', 'Stage annex cites a record outside the current root')
      continue
    }
    if (owned) return actionFailure('self-output', 'Correction stage source is not an authenticated prior input')
    const prior = priorCorrectionStage(ref, request, histories, catalogues)
    if (!prior.ok) return prior
    if (!prior.value) return actionFailure('self-output', 'Correction stage source is not an authenticated prior input')
  }
  return { ok: true, value: true }
}
