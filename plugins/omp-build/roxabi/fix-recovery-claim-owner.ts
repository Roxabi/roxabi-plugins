import type { CanonicalRecord, DecodedHistory, GitHubOptions } from '../dist/contracts.js'
import {
  assessFixOwnerAdmission,
  canonicalValueDigest,
  projectRecoveryHistories,
  replayFixRecoveryControl,
} from '../dist/contracts.js'
import type { FixRecoveryNativePreparation } from '../engine/fix-recovery-control-schema.ts'
import type { ReservedRecordIdentity } from '../engine/fix-recovery-identities.ts'
import type { FixRecoveryCurrentFacts } from '../engine/fix-recovery-observation.ts'
import type { UwGraphObservation } from '../engine/uw-graph.ts'
import type { FixActionResult, FixIdentity, PreparedFix } from './fix-contract.ts'
import { failure, recoveryDiagnosticStrings } from './fix-contract.ts'
import type { FixExecutionFence } from './fix-execution-fence.ts'
import { publishConfirmedFixOwner } from './fix-owner-publication.ts'

/** Re-run the factual claim gate and publish the exact reserved resume owner, never mint C0/R. */
export async function publishRecoveryClaimOwner(input: {
  control: Extract<CanonicalRecord, { kind: 'fix-recovery' }>
  reservation: ReservedRecordIdentity<'fix-owner'>
  identity: FixIdentity
  fence: FixExecutionFence
  current: FixRecoveryCurrentFacts
  graph: UwGraphObservation
  histories: readonly DecodedHistory[]
  nativePreparation: FixRecoveryNativePreparation
  github: GitHubOptions
  prepared: Pick<PreparedFix, 'cwd' | 'target' | 'publishBinding'>
  readHistories: () => Promise<FixActionResult<readonly DecodedHistory[]>>
}): Promise<FixActionResult<void>> {
  const replay = replayFixRecoveryControl({ control: input.control, histories: input.histories })
  if (!replay.ok) return failure('fix-recovery-control-unconfirmed', ...recoveryDiagnosticStrings(replay.diagnostics))
  if (replay.value.proposal.phase !== 'adopt-decision') return failure('fix-recovery-control-unconfirmed')
  const proposal = replay.value.proposal
  if (canonicalValueDigest(proposal.claimReservation) !== canonicalValueDigest(input.reservation))
    return failure('fix-recovery-claim-reservation-mismatch')
  const projected = projectRecoveryHistories(input.histories)
  if (!projected.ok) return failure(...recoveryDiagnosticStrings(projected.diagnostics))
  const gate = assessFixOwnerAdmission({
    uw: proposal.uw,
    pullRequest: proposal.pullRequest,
    destination: input.current.pullRequest.destination,
    graph: input.graph,
    histories: input.histories,
    effectiveHistories: projected.value,
    intent: 'claim',
    claim: { reservation: input.reservation, current: input.current, nativePreparation: input.nativePreparation },
  })
  if (!gate.ok || gate.value.status !== 'claim')
    return failure('fix-recovery-claim-refused', ...(gate.ok ? [] : recoveryDiagnosticStrings(gate.diagnostics)))
  const lease = input.fence.destinationLeaseFacts()
  const root = input.fence.snapshot().root
  if (
    lease === null ||
    lease.host === null ||
    root === null ||
    canonicalValueDigest(lease.owner) !== canonicalValueDigest(input.reservation) ||
    canonicalValueDigest(root) !== canonicalValueDigest(input.current.host.root) ||
    canonicalValueDigest(lease.host.process) !== canonicalValueDigest(input.current.host.process) ||
    canonicalValueDigest(lease.host.namespace) !== canonicalValueDigest(input.current.host.namespace) ||
    !(await input.fence.recheckDestinationLease())
  )
    return failure('fix-recovery-claim-lease-unconfirmed')
  const { authority, pullRequest } = input.current
  const uw = proposal.uw
  const scopes =
    uw.repository === pullRequest.scope.repository && uw.target === pullRequest.scope.target
      ? [uw]
      : [uw, pullRequest.scope]
  const opened = await publishConfirmedFixOwner({
    identity: input.reservation,
    github: input.github,
    histories: input.histories,
    fence: input.fence,
    payload: {
      format: 'omp-build-fix-owner/1',
      phase: 'opened',
      common: {
        owner: input.reservation,
        operationPrefix: input.identity.operationId,
        host: { kind: 'linux-qualified', platform: 'linux', admission: lease.descriptor, ...lease.host },
        root,
        destination: pullRequest.destination,
        uw,
        pullRequest: pullRequest.scope,
        writeScopes: scopes,
        mandate: proposal.mandate,
        binding: proposal.binding,
        plugin: authority.plugin,
        configuration: authority.configuration,
        accepted: authority.accepted,
        acceptedDigest: canonicalValueDigest(authority.accepted),
      },
      intent: {
        kind: 'resume-decision',
        recovery: {
          scope: { repository: input.control.repository, target: input.control.target },
          kind: 'fix-recovery',
          recordId: input.control.recordId,
        },
        source: proposal.target.source,
        request: proposal.target.request,
        decision: proposal.target.decision,
      },
    },
    settlementBasis: { prepared: input.prepared, readHistories: input.readHistories },
  })
  return opened.ok ? { ok: true, value: undefined } : opened
}
