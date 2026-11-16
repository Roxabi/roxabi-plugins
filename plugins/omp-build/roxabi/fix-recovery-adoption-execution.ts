import type { CanonicalRecord, DecodedHistory, GitHubOptions } from '../dist/contracts.js'
import { bindExternalRef, canonicalValueDigest, projectRecoveryHistories } from '../dist/contracts.js'
import { buildConfirmedFixRecoveryAdoption, prepareFixRecoveryAdoption } from '../engine/fix-recovery-close.ts'
import type { FixRecoveryNativePreparation } from '../engine/fix-recovery-control-schema.ts'
import type { ReservedRecordIdentity } from '../engine/fix-recovery-identities.ts'
import { type FixRecoveryCurrentFacts, makeFixRecoveryObservation } from '../engine/fix-recovery-observation.ts'
import { assessFixOwnerAdmission } from '../engine/fix-recovery-owner-admission.ts'
import { replayFixRecoveryControl } from '../engine/fix-recovery-replay.ts'
import type { UwGraphObservation } from '../engine/uw-graph.ts'
import {
  type DestinationAdmissionLease,
  recheckDestinationAdmissionLease,
} from '../omp/review-runtime/destination-admission-lease.ts'
import type { FixActionResult, FixRecord } from './fix-contract.ts'
import { failure, recoveryDiagnosticStrings } from './fix-contract.ts'
import { createGitHubRecordPublisher } from './github-publisher.ts'
import type { OperatorPort } from './uw-contract.ts'

type Current = {
  histories: readonly DecodedHistory[]
  graph: UwGraphObservation
  current: FixRecoveryCurrentFacts
  nativePreparation: FixRecoveryNativePreparation
}
type Control = Extract<CanonicalRecord, { kind: 'fix-recovery' }>

/** Confirmation binds a fresh real preflight; claim is gated again after exact publication/readback. */
export async function executeFixRecoveryAdoption(input: {
  control: ReservedRecordIdentity<'fix-recovery'>
  claimReservation: ReservedRecordIdentity<'fix-owner'>
  lease: DestinationAdmissionLease
  github: GitHubOptions
  operator: OperatorPort
  rootCurrent: () => boolean
  readCurrent: () => Promise<FixActionResult<Current>>
  claimAndContinue: (input: { control: Control; current: Current }) => Promise<FixActionResult<FixRecord>>
}): Promise<FixActionResult<FixRecord>> {
  const read = async (): Promise<FixActionResult<Current>> => {
    const before = await recheckDestinationAdmissionLease(input.lease)
    if (before.status !== 'held' || !input.rootCurrent()) return failure('fix-recovery-lease-unconfirmed')
    const current = await input.readCurrent()
    if (!current.ok) return current
    const destination = current.value.current.pullRequest.destination
    if (
      canonicalValueDigest([destination.authority, destination.publicationRepository, destination.destinationRef]) !==
      before.descriptor.destinationDigest
    )
      return failure('fix-recovery-lease-destination-mismatch')
    const after = await recheckDestinationAdmissionLease(input.lease)
    return after.status === 'held' && input.rootCurrent() ? current : failure('fix-recovery-lease-unconfirmed')
  }
  const prepare = (value: Current) => {
    const observation = makeFixRecoveryObservation(value)
    if (!observation.ok) return failure(...recoveryDiagnosticStrings(observation.diagnostics))
    const result = prepareFixRecoveryAdoption({
      control: input.control,
      claimReservation: input.claimReservation,
      observation: observation.value,
      histories: value.histories,
      graph: value.graph,
      nativePreparation: value.nativePreparation,
    })
    return result.ok
      ? { ok: true as const, value: result.value }
      : failure(...recoveryDiagnosticStrings(result.diagnostics))
  }
  const readback = async (built: Control) => {
    const after = await read()
    if (!after.ok) return after
    const home = after.value.histories.find(
      (history) =>
        history.source.scope.repository === input.control.scope.repository &&
        history.source.scope.target === input.control.scope.target,
    )
    if (home === undefined) return failure('fix-recovery-readback-unavailable')
    const bound = bindExternalRef(
      { scope: input.control.scope, kind: 'fix-recovery', recordId: input.control.recordId },
      home,
    )
    if (
      !bound.ok ||
      bound.value.kind !== 'fix-recovery' ||
      canonicalValueDigest(bound.value) !== canonicalValueDigest(built)
    )
      return failure('fix-recovery-readback-unconfirmed')
    const replay = replayFixRecoveryControl({ control: bound.value, histories: after.value.histories })
    if (!replay.ok) return failure(...recoveryDiagnosticStrings(replay.diagnostics))
    return { ok: true as const, value: { control: bound.value, current: after.value } }
  }
  const admitAndContinue = async (verified: { control: Control; current: Current }) => {
    const after = verified.current
    const projected = projectRecoveryHistories(after.histories)
    if (!projected.ok) return failure(...recoveryDiagnosticStrings(projected.diagnostics))
    const admission = assessFixOwnerAdmission({
      uw: after.current.authority.accepted.own.uw,
      pullRequest: after.current.pullRequest.scope,
      destination: after.current.pullRequest.destination,
      graph: after.graph,
      histories: after.histories,
      effectiveHistories: projected.value,
      intent: 'claim',
      claim: {
        reservation: input.claimReservation,
        current: after.current,
        nativePreparation: after.nativePreparation,
      },
    })
    if (!admission.ok || admission.value.status !== 'claim')
      return failure(
        'fix-recovery-claim-refused',
        ...(admission.ok ? [] : recoveryDiagnosticStrings(admission.diagnostics)),
      )
    if (!input.rootCurrent() || (await recheckDestinationAdmissionLease(input.lease)).status !== 'held')
      return failure('fix-recovery-lease-unconfirmed')
    return input.claimAndContinue({ control: verified.control, current: after })
  }
  const initial = await read()
  if (!initial.ok) return initial
  const prepared = prepare(initial.value)
  if (!prepared.ok) return prepared
  const confirmed = await input.operator.executeConfirmed(prepared.value, async (confirmation) => {
    const latest = await read()
    if (!latest.ok) return latest
    const fresh = prepare(latest.value)
    if (!fresh.ok) return fresh
    const built = buildConfirmedFixRecoveryAdoption({
      prepared: prepared.value,
      fresh: fresh.value,
      confirmation,
      histories: latest.value.histories,
      graph: latest.value.graph,
    })
    if (!built.ok) return failure(...recoveryDiagnosticStrings(built.diagnostics))
    const held = await recheckDestinationAdmissionLease(input.lease)
    if (held.status !== 'held' || !input.rootCurrent()) return failure('fix-recovery-lease-unconfirmed')
    const saved = await createGitHubRecordPublisher(input.control.scope, input.github, null).publish(
      built.value,
      latest.value.histories,
      input.rootCurrent,
    )
    if (!saved.ok) return saved
    const verified = await readback(built.value)
    if (!verified.ok) return verified
    return admitAndContinue(verified.value)
  })
  return confirmed.status === 'confirmed'
    ? confirmed.value
    : failure(...recoveryDiagnosticStrings(confirmed.diagnostics))
}
