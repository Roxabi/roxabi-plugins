import { canonicalValueDigest } from './action-input.ts'
import type { FixRecoveryRead } from './fix-recovery-discovery.ts'
import { deriveInterruptedPhase } from './fix-recovery-discovery-phase.ts'
import {
  asOpenedRef,
  asSettledRef,
  findOperation,
  identityKey,
  matchesCompletePin,
  type OwnerPair,
} from './fix-recovery-discovery-records.ts'
import type { PartPin, RecordPin, ReservedRecordIdentity } from './fix-recovery-identities.ts'
import { observedPartsMatch } from './fix-recovery-part-pins.ts'
import type { InterruptedPhase } from './fix-recovery-phase-schema.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic } from './record-diagnostics.ts'

function phaseSourceIdentity(phase: InterruptedPhase): ReservedRecordIdentity<string> {
  if (phase.kind !== 'publication-prefix') return phase.source.identity
  return phase.source.state === 'complete' ? phase.source.record.identity : phase.source.reservation
}

function phaseRequestIdentity(phase: InterruptedPhase): ReservedRecordIdentity<string> {
  return phase.kind === 'publication-prefix' ? phase.request.reservation : phase.request.identity
}

export function validateSettledPublications(
  pair: OwnerPair,
  histories: readonly DecodedHistory[],
): FixRecoveryRead | null {
  const acceptedDigest = canonicalValueDigest(pair.opened.payload.common.accepted)
  if (acceptedDigest !== pair.opened.payload.common.acceptedDigest) {
    return {
      status: 'blocked',
      diagnostics: [diagnostic('ambiguous', 'Owner acceptedDigest does not match the accepted Spec')],
    }
  }
  for (const outbound of pair.settled.payload.outbound) {
    if (outbound.publication.state === 'confirmed' && !matchesCompletePin(histories, outbound.publication.record))
      return { status: 'blocked', diagnostics: [diagnostic('incomplete', 'A confirmed outbound pin does not resolve')] }
    if (outbound.publication.state === 'submitted-unconfirmed') {
      const operation = findOperation(histories, outbound.identity)
      if (
        (operation === null && outbound.publication.observedParts.length !== 0) ||
        (operation !== null && !observedPartsMatch(outbound.publication.observedParts, operation, false))
      )
        return {
          status: 'blocked',
          diagnostics: [diagnostic('ambiguous', 'A submitted outbound fragment changed or disappeared')],
        }
    }
  }
  return validatePhaseFragments(pair, histories)
}

function phasePins(phase: InterruptedPhase): RecordPin<string>[] {
  if (phase.kind === 'publication-prefix') return phase.source.state === 'complete' ? [phase.source.record] : []
  if (phase.kind === 'decided') return [phase.source, phase.request, phase.decision]
  return [phase.source, phase.request]
}

function phaseFragments(
  claimed: InterruptedPhase,
): { reservation: ReservedRecordIdentity<string>; observedParts: PartPin[] }[] {
  const fragments: { reservation: ReservedRecordIdentity<string>; observedParts: PartPin[] }[] = []
  if (claimed.kind === 'publication-prefix') {
    if (claimed.source.state === 'submitted-unconfirmed') fragments.push(claimed.source)
    if (claimed.request.state === 'submitted-unconfirmed') fragments.push(claimed.request)
  } else if (claimed.kind === 'request-before-decision' && claimed.decision.state === 'submitted-unconfirmed') {
    fragments.push(claimed.decision)
  }
  return fragments
}

function validatePhaseFragments(pair: OwnerPair, histories: readonly DecodedHistory[]): FixRecoveryRead | null {
  const claimed = pair.settled.payload.interrupted
  for (const fragment of phaseFragments(claimed)) {
    const operation = findOperation(histories, fragment.reservation)
    if (
      (operation === null && fragment.observedParts.length !== 0) ||
      (operation !== null && !observedPartsMatch(fragment.observedParts, operation, false))
    )
      return {
        status: 'blocked',
        diagnostics: [diagnostic('ambiguous', 'A settled phase fragment changed or disappeared')],
      }
  }
  const claimedPins = phasePins(claimed)
  if (claimedPins.some((pin) => !matchesCompletePin(histories, pin)))
    return {
      status: 'blocked',
      diagnostics: [diagnostic('incomplete', 'A complete settled phase pin does not resolve')],
    }
  return null
}

export function deriveObservedPhase(pair: OwnerPair, histories: readonly DecodedHistory[]): FixRecoveryRead {
  const claimed = pair.settled.payload.interrupted
  const claimedPins = phasePins(claimed)
  const derived = deriveInterruptedPhase(pair.opened, pair.settled.payload.outbound, histories)
  if (!derived.ok) return { status: 'blocked', diagnostics: derived.diagnostics }
  if (
    (claimed.kind === 'decided' && derived.value.kind !== 'decided') ||
    (claimed.kind === 'request-before-decision' && derived.value.kind === 'publication-prefix')
  )
    return {
      status: 'blocked',
      diagnostics: [diagnostic('ambiguous', 'Observed phase would downgrade a complete settled claim')],
    }
  if (
    identityKey(phaseSourceIdentity(claimed)) !== identityKey(phaseSourceIdentity(derived.value)) ||
    identityKey(phaseRequestIdentity(claimed)) !== identityKey(phaseRequestIdentity(derived.value))
  )
    return {
      status: 'blocked',
      diagnostics: [diagnostic('ambiguous', 'Settled phase names different source or request identities')],
    }
  const actual = derived.value
  const actualPins = phasePins(actual)
  if (
    claimedPins.some(
      (pin) => !actualPins.some((actualPin) => canonicalValueDigest(pin) === canonicalValueDigest(actualPin)),
    )
  )
    return {
      status: 'blocked',
      diagnostics: [diagnostic('ambiguous', 'Settled complete claim does not identify the observed phase')],
    }
  return {
    status: 'interrupted',
    phase: derived.value,
    owner: asOpenedRef(pair.opened),
    settled: asSettledRef(pair.settled),
  }
}
