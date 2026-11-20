import { assessUwAdmission, canonicalValueDigest } from '../dist/contracts.js'
import type { Result } from '../engine/result.ts'
import type { ActionInputManifest, CurrentActionFacts, RecordInputRef, UwActionRequest } from './uw-action-contract.ts'
import { actionFailure } from './uw-action-result.ts'
import { type IntegrationStageObservation, integrationProofInputs } from './uw-action-stage-closure.ts'
import type { UwRead } from './uw-contract.ts'
import { withTransitionAdmission } from './uw-read-transition.ts'

export type PreparedActionManifest = {
  manifest: ActionInputManifest
  stageSources: readonly RecordInputRef[]
  verifiedPluginFiles: readonly { path: string; bytes: Uint8Array }[]
}

export function admitIntegrationRead(request: UwActionRequest, read: UwRead): UwRead | Promise<UwRead> {
  return request.purpose === 'integrate' ? withTransitionAdmission({ assessUwAdmission }, read) : read
}

export function discoverIntegrationSources(
  request: UwActionRequest,
  read: UwRead,
  prepublication = true,
): Result<readonly RecordInputRef[] | undefined> {
  if (request.expectedIntegrationParent === undefined) return { ok: true, value: undefined }
  if (
    request.purpose !== 'integrate' ||
    request.stageSources.length !== 0 ||
    request.expandedContext.length !== 0 ||
    !prepublication ||
    read.accepted.status !== 'accepted' ||
    canonicalValueDigest(read.accepted.value) !== canonicalValueDigest(request.expectedIntegrationParent)
  )
    return actionFailure('review-input-changed', 'Expected integration parent or source mode changed')
  const projected = integrationProofInputs(read)
  return projected.ok ? { ok: true, value: projected.value.stageSources } : projected
}

export function integrationObservation(
  request: UwActionRequest,
  read: UwRead,
  accepted: IntegrationStageObservation['accepted'] | null,
  acceptedSources: readonly RecordInputRef[],
  stageSources: readonly RecordInputRef[] | undefined,
): IntegrationStageObservation | undefined {
  return request.purpose === 'integrate' && accepted !== null
    ? { read, accepted, acceptedSources, stageSources }
    : undefined
}

export function preparedStageSources(
  request: UwActionRequest,
  facts: CurrentActionFacts,
): Result<readonly RecordInputRef[]> {
  if (
    request.expectedIntegrationParent !== undefined &&
    (request.purpose !== 'integrate' ||
      request.stageSources.length !== 0 ||
      request.expandedContext.length !== 0 ||
      facts.integrationStageSources === undefined)
  )
    return actionFailure('review-input-changed', 'Integration discovery requires a fresh unexpanded source observation')
  return { ok: true, value: facts.integrationStageSources ?? request.stageSources }
}

export function refuseIntegrationReplayDiscovery(request: UwActionRequest): Result<true> {
  return request.expectedIntegrationParent === undefined
    ? { ok: true, value: true }
    : actionFailure('review-input-changed', 'Integration discovery is not allowed during replay')
}
