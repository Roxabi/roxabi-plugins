import type { CanonicalRecord, DecodedHistory, GitHubOptions } from '../dist/contracts.js'
import { bindExternalRef, canonicalValueDigest } from '../dist/contracts.js'
import { buildConfirmedFixRecoveryClose, prepareFixRecoveryClose } from '../engine/fix-recovery-close.ts'
import type { ReservedRecordIdentity } from '../engine/fix-recovery-identities.ts'
import { type FixRecoveryCurrentFacts, makeFixRecoveryObservation } from '../engine/fix-recovery-observation.ts'
import { replayFixRecoveryClose } from '../engine/fix-recovery-replay.ts'
import type { UwGraphObservation } from '../engine/uw-graph.ts'
import {
  type DestinationAdmissionLease,
  recheckDestinationAdmissionLease,
} from '../omp/review-runtime/destination-admission-lease.ts'
import { observeCurrentLinuxHost } from '../omp/review-runtime/linux-execution-lease.ts'
import type { FixActionResult } from './fix-contract.ts'
import { failure, recoveryDiagnosticStrings } from './fix-contract.ts'
import { createGitHubRecordPublisher } from './github-publisher.ts'
import type { OperatorPort } from './uw-contract.ts'

type LiveRead = { histories: readonly DecodedHistory[]; graph: UwGraphObservation; current: FixRecoveryCurrentFacts }
type Control = Extract<CanonicalRecord, { kind: 'fix-recovery' }>

/** Private composition boundary: both observations are fresh host reads under the same held lease. */
export async function executeFixRecoveryClose(input: {
  control: ReservedRecordIdentity<'fix-recovery'>
  lease: DestinationAdmissionLease
  github: GitHubOptions
  operator: OperatorPort
  rootCurrent: () => boolean
  readCurrent: () => Promise<FixActionResult<LiveRead>>
}): Promise<FixActionResult<void>> {
  const observe = async () => {
    if (!input.rootCurrent()) return failure<LiveRead>('fix-recovery-root-changed')
    const lease = await recheckDestinationAdmissionLease(input.lease)
    if (lease.status !== 'held') return failure<LiveRead>('fix-recovery-lease-unconfirmed')
    const read = await input.readCurrent()
    if (!read.ok) return read
    const destination = read.value.current.pullRequest.destination
    const host = await observeCurrentLinuxHost()
    if (
      !input.rootCurrent() ||
      host.status !== 'qualified' ||
      canonicalValueDigest([destination.authority, destination.publicationRepository, destination.destinationRef]) !==
        lease.descriptor.destinationDigest ||
      canonicalValueDigest(read.value.current.host.process) !== canonicalValueDigest(host.process) ||
      canonicalValueDigest(read.value.current.host.namespace) !== canonicalValueDigest(host.namespace)
    )
      return failure<LiveRead>('fix-recovery-observation-lease-mismatch')
    const rechecked = await recheckDestinationAdmissionLease(input.lease)
    return rechecked.status === 'held' && input.rootCurrent()
      ? read
      : failure<LiveRead>('fix-recovery-lease-unconfirmed')
  }
  const initial = await observe()
  if (!initial.ok) return initial
  const observation = makeFixRecoveryObservation(initial.value)
  if (!observation.ok) return failure(...recoveryDiagnosticStrings(observation.diagnostics))
  const prepared = prepareFixRecoveryClose({
    control: input.control,
    observation: observation.value,
    histories: initial.value.histories,
  })
  if (!prepared.ok) return failure(...recoveryDiagnosticStrings(prepared.diagnostics))
  const verifyReadback = (built: Control, after: LiveRead): FixActionResult<void> => {
    const history = after.histories.find(
      (item) =>
        item.source.scope.repository === input.control.scope.repository &&
        item.source.scope.target === input.control.scope.target,
    )
    if (history === undefined) return failure('fix-recovery-readback-unavailable')
    const bound = bindExternalRef(
      { scope: input.control.scope, kind: 'fix-recovery', recordId: input.control.recordId },
      history,
    )
    if (
      !bound.ok ||
      bound.value.kind !== 'fix-recovery' ||
      canonicalValueDigest(bound.value) !== canonicalValueDigest(built)
    )
      return failure('fix-recovery-readback-unconfirmed')
    const replayed = replayFixRecoveryClose({ control: bound.value, histories: after.histories })
    if (!replayed.ok) return failure(...recoveryDiagnosticStrings(replayed.diagnostics))
    return { ok: true, value: undefined }
  }
  const confirmed = await input.operator.executeConfirmed(prepared.value, async (confirmation) => {
    const latest = await observe()
    if (!latest.ok) return latest
    const freshObservation = makeFixRecoveryObservation(latest.value)
    if (!freshObservation.ok) return failure(...recoveryDiagnosticStrings(freshObservation.diagnostics))
    const fresh = prepareFixRecoveryClose({
      control: input.control,
      observation: freshObservation.value,
      histories: latest.value.histories,
    })
    if (!fresh.ok) return failure(...recoveryDiagnosticStrings(fresh.diagnostics))
    const built = buildConfirmedFixRecoveryClose({
      prepared: prepared.value,
      fresh: fresh.value,
      confirmation,
      histories: latest.value.histories,
    })
    if (!built.ok) return failure(...recoveryDiagnosticStrings(built.diagnostics))
    const publishAndReadback = async () => {
      const stillHeld = await recheckDestinationAdmissionLease(input.lease)
      if (stillHeld.status !== 'held' || !input.rootCurrent()) return failure('fix-recovery-lease-unconfirmed')
      const saved = await createGitHubRecordPublisher(input.control.scope, input.github, null).publish(
        built.value,
        latest.value.histories,
        input.rootCurrent,
      )
      if (!saved.ok) return saved
      const after = await observe()
      if (!after.ok) return after
      return verifyReadback(built.value, after.value)
    }
    return publishAndReadback()
  })
  return confirmed.status === 'confirmed'
    ? confirmed.value
    : failure(...recoveryDiagnosticStrings(confirmed.diagnostics))
}
