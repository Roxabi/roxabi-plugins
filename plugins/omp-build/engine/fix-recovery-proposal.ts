import { canonicalValueDigest } from './action-input.ts'
import {
  type FixRecoveryObservation,
  type FixRecoveryProposal,
  fixRecoveryProposalSchema,
} from './fix-recovery-control-schema.ts'
import { diagnostic, equalScope } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Result } from './result.ts'

function fixRecoveryObservationDigest(observation: FixRecoveryObservation): string {
  return canonicalValueDigest(observation)
}

function fixRecoveryProposalDigest(proposal: FixRecoveryProposal): string {
  return canonicalValueDigest(proposal)
}

/** Canonical digest preimages; this calculation alone conveys no authority. */
export function fixRecoveryExpected(observation: FixRecoveryObservation): FixRecoveryProposal['expected'] {
  const { histories, graph, authority, pullRequest, local } = observation
  return {
    currentStateDigest: canonicalValueDigest({
      format: 'omp-build-fix-recovery-current-state/1',
      histories,
      graph,
      authority,
      pullRequest,
      local,
    }),
    headDigest: canonicalValueDigest({
      pullRequest: pullRequest.scope,
      candidateGitSHA: pullRequest.candidateGitSHA,
      baseGitSHA: pullRequest.baseGitSHA,
      localHead: local.head,
      remoteHead: local.remoteHead,
      destination: pullRequest.destination,
    }),
    pinDigest: canonicalValueDigest({ plugin: authority.plugin, configuration: authority.configuration }),
    mandateDigest: authority.mandate.envelopeDigest,
    acceptedSpecDigest: canonicalValueDigest(authority.accepted),
  }
}

/** Reconstruct and checksum the exact displayed preimage; replay must separately authenticate the finite cut. */
export function fixRecoveryProposalFromControl(
  record: Extract<CanonicalRecord, { kind: 'fix-recovery' }>,
): Result<FixRecoveryProposal> {
  const payload = record.payload
  const { repository, target, runId, operationId, recordId } = record
  const common = {
    format: 'omp-build-fix-recovery-proposal/1' as const,
    operationId,
    control: { scope: { repository, target }, kind: 'fix-recovery' as const, runId, operationId, recordId },
    uw: payload.uw,
    pullRequest: payload.pullRequest,
    binding: payload.binding,
    mandate: payload.mandate,
    predecessor: payload.predecessor,
    opened: payload.opened,
    settled: payload.settled,
    cuts: payload.cuts,
    observation: payload.observation,
    observationDigest: payload.observationDigest,
    expected: fixRecoveryExpected(payload.observation),
  }
  const phase =
    payload.phase === 'adopt-decision'
      ? {
          phase: payload.phase,
          target: payload.target,
          claimReservation: payload.claimReservation,
          nativePreparation: payload.nativePreparation,
        }
      : { phase: payload.phase, target: payload.target }
  const parsed = fixRecoveryProposalSchema.safeParse({ ...common, ...phase })
  if (
    !parsed.success ||
    !equalScope(record, payload.pullRequest) ||
    payload.observationDigest !== fixRecoveryObservationDigest(payload.observation) ||
    payload.confirmation.operationId !== operationId ||
    payload.confirmation.route !== 'omp-native-command' ||
    payload.confirmation.proposalDigest !== payload.proposalDigest ||
    fixRecoveryProposalDigest(parsed.data) !== payload.proposalDigest
  )
    return {
      ok: false,
      diagnostics: [diagnostic('unconfirmed', 'Recovery proposal or confirmation preimage does not match its control')],
    }
  return { ok: true, value: parsed.data }
}
