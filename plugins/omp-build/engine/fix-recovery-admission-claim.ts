import { canonicalValueDigest } from './action-input.ts'
import { validateRecoveryAdoptionPlan } from './fix-recovery-adoption-assessment.ts'
import type { FixRecoveryNativePreparation, FixRecoveryObservation } from './fix-recovery-control-schema.ts'
import type { ReservedRecordIdentity } from './fix-recovery-identities.ts'
import { type FixRecoveryCurrentFacts, makeFixRecoveryClaimObservation } from './fix-recovery-observation.ts'
import { commentAsPartPin, partPinsEqual } from './fix-recovery-part-pins.ts'
import { replayFixRecoveryControl } from './fix-recovery-replay.ts'
import type { LatchNamespace } from './fix-recovery-schema.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Result } from './result.ts'
import type { UwGraphObservation } from './uw-graph.ts'

export type AdmissionClaim = {
  reservation: ReservedRecordIdentity<'fix-owner'>
  current: FixRecoveryCurrentFacts
  nativePreparation: FixRecoveryNativePreparation
}
type Control = Extract<CanonicalRecord, { kind: 'fix-recovery' }>
type AdoptionPayload = Extract<Control['payload'], { phase: 'adopt-decision' }>
const fail = (message: string): Result<never> => ({ ok: false, diagnostics: [diagnostic('unconfirmed', message)] })

function reservationAvailable(
  claim: AdmissionClaim,
  payload: AdoptionPayload,
  histories: readonly DecodedHistory[],
): boolean {
  return (
    canonicalValueDigest(claim.reservation) === canonicalValueDigest(payload.claimReservation) &&
    canonicalValueDigest(claim.nativePreparation) === canonicalValueDigest(payload.nativePreparation) &&
    !histories.some(
      (history) =>
        equalScope(history.source.scope, claim.reservation.scope) &&
        history.operations.some(
          (operation) =>
            operation.operationId === claim.reservation.operationId ||
            operation.recordId === claim.reservation.recordId,
        ),
    )
  )
}
function compareClaimCut(
  control: Control,
  histories: readonly DecodedHistory[],
  fresh: FixRecoveryObservation,
  previous: FixRecoveryObservation,
): Result<void> {
  const controlOperation = histories
    .flatMap((history) => history.operations)
    .find(
      (operation) =>
        operation.record?.kind === 'fix-recovery' &&
        operation.record.operationId === control.operationId &&
        operation.record.recordId === control.recordId,
    )
  if (controlOperation === undefined) return fail('Confirmed adoption control is unavailable')
  const newPins = controlOperation.parts.map(commentAsPartPin)
  if (newPins.some((pin) => pin === null) || fresh.histories.length !== previous.histories.length)
    return fail('Adoption current history cannot be compared to the confirmed finite cut')
  for (const old of previous.histories) {
    const current = fresh.histories.find((history) => equalScope(history.scope, old.scope))
    if (
      current === undefined ||
      old.parts.some((pin) => !current.parts.some((part) => partPinsEqual(pin, part))) ||
      current.parts.some(
        (pin) =>
          !old.parts.some((part) => partPinsEqual(pin, part)) &&
          !newPins.some((part) => part !== null && partPinsEqual(pin, part)),
      )
    )
      return fail('Adoption history changed beyond the confirmed control publication')
  }
  return { ok: true, value: undefined }
}

export function assessAdmissionClaim(input: {
  intent: 'fresh' | 'recovery' | 'claim'
  claim?: AdmissionClaim
  control: Control
  priorNamespace: LatchNamespace | null
  histories: readonly DecodedHistory[]
  graph: UwGraphObservation
}): Result<{ status: 'claim'; claimReservation: ReservedRecordIdentity<'fix-owner'>; priorNamespace: LatchNamespace }> {
  const { claim, control, histories, graph, priorNamespace } = input
  if (
    input.intent !== 'claim' ||
    claim === undefined ||
    priorNamespace === null ||
    control.payload.phase !== 'adopt-decision' ||
    !reservationAvailable(claim, control.payload, histories)
  )
    return fail('Adoption claim does not match its exclusive reservation')
  const fresh = makeFixRecoveryClaimObservation({ control, histories, graph, current: claim.current })
  if (!fresh.ok) return fresh
  const replayed = replayFixRecoveryControl({ control, histories })
  if (!replayed.ok || replayed.value.proposal.phase !== 'adopt-decision')
    return fail('Adoption control cannot be replayed')
  const proposal = replayed.value.proposal
  const previous = proposal.observation
  if (canonicalValueDigest({ ...fresh.value, histories: previous.histories }) !== canonicalValueDigest(previous))
    return fail('Adoption authority, local state, graph or native preparation changed after confirmation')
  const cut = compareClaimCut(control, histories, fresh.value, previous)
  if (!cut.ok) return cut
  const currentProposal = { ...proposal, observation: fresh.value, nativePreparation: claim.nativePreparation }
  const plan = validateRecoveryAdoptionPlan({ proposal: currentProposal, histories, graph })
  if (!plan.ok) return plan
  return { ok: true, value: { status: 'claim', claimReservation: claim.reservation, priorNamespace } }
}
