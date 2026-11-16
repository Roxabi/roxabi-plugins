import type { FixRecoveryProposal } from './fix-recovery-control-schema.ts'
import { buildRecord } from './record-construction.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Result } from './result.ts'
import type { OperatorConfirmationEvidence } from './uw-identity-schema.ts'

type Control = Extract<CanonicalRecord, { kind: 'fix-recovery' }>
type Adoption = Extract<FixRecoveryProposal, { phase: 'adopt-decision' }>
type Close = Extract<FixRecoveryProposal, { phase: 'close-publication' | 'close-predecision' }>

export function buildAdoptionRecord(
  proposal: Adoption,
  digest: string,
  confirmation: OperatorConfirmationEvidence,
): Result<Control> {
  const {
    control,
    observation,
    observationDigest,
    uw,
    pullRequest,
    binding,
    mandate,
    predecessor,
    opened,
    settled,
    cuts,
    target,
    claimReservation,
    nativePreparation,
  } = proposal
  return buildRecord({
    ...control.scope,
    version: 1,
    recordId: control.recordId,
    runId: control.runId,
    operationId: control.operationId,
    kind: 'fix-recovery',
    payload: {
      format: 'omp-build-fix-recovery/1',
      phase: 'adopt-decision',
      uw,
      pullRequest,
      binding,
      mandate,
      predecessor,
      opened,
      settled,
      cuts,
      observation,
      observationDigest,
      proposalDigest: digest,
      confirmation,
      target,
      claimReservation,
      nativePreparation,
    },
  })
}

export function buildCloseRecord(
  proposal: Close,
  digest: string,
  confirmation: OperatorConfirmationEvidence,
): Result<Control> {
  const {
    control,
    observation,
    observationDigest,
    uw,
    pullRequest,
    binding,
    mandate,
    predecessor,
    opened,
    settled,
    cuts,
  } = proposal
  const common = {
    format: 'omp-build-fix-recovery/1' as const,
    uw,
    pullRequest,
    binding,
    mandate,
    predecessor,
    opened,
    settled,
    cuts,
    observation,
    observationDigest,
    proposalDigest: digest,
    confirmation,
  }
  const payload =
    proposal.phase === 'close-publication'
      ? { ...common, phase: proposal.phase, target: proposal.target }
      : { ...common, phase: proposal.phase, target: proposal.target }
  return buildRecord({
    ...control.scope,
    version: 1,
    recordId: control.recordId,
    runId: control.runId,
    operationId: control.operationId,
    kind: 'fix-recovery',
    payload,
  })
}
