import type { RecordInputRef } from './action-input-refs.ts'
import { canonicalValueDigest } from './canonical-value.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, sameOwnSpecRef, sameRef } from './record-diagnostics.ts'
import type { Result } from './result.ts'
import type { OwnSpecRef } from './uw-spec-schema.ts'
import type { Chain } from './workflow-accepted-spec-discovery.ts'
import type { AcceptedOwnSpec, CompatibilityOperandReader } from './workflow-accepted-spec-types.ts'
import { bindExternalRef, historyFor } from './workflow-control.ts'
import type { AssessSpecExact } from './workflow-receipt-schema.ts'
import { sameAssessedState } from './workflow-spec-assessment.ts'

function unavailable(code: string, message: string): Result<never> {
  return { ok: false, diagnostics: [diagnostic(code, message)] }
}

export function matchesAcceptedOrigin(prefix: AcceptedOwnSpec, ref: OwnSpecRef): boolean {
  if (!sameOwnSpecRef(prefix.ref, ref)) return false
  const step = prefix.chain.at(-1)
  return step !== undefined && sameRef(step.source, ref.sourceAccepted)
}

function capturedMetadataHead(
  chain: Pick<Chain, 'prefixes'>,
  state: AssessSpecExact['accepted'],
  captured: readonly RecordInputRef[],
  histories: readonly DecodedHistory[],
): Result<AcceptedOwnSpec | undefined> {
  const matching = chain.prefixes.filter((prefix) => sameOwnSpecRef(prefix.ref, state.ref))
  let latest: AcceptedOwnSpec | undefined
  let gap = false
  for (const prefix of matching) {
    const step = prefix.chain.at(-1)
    if (step === undefined)
      return unavailable('accepted-metadata-unavailable', 'Captured metadata pin is not authenticated')
    const source = step.source
    const pins = captured.filter((pin) => pin.selector === '/payload' && sameRef(pin.record, source))
    if (pins.length === 0) {
      gap = true
      continue
    }
    if (gap || pins.length !== 1)
      return unavailable('accepted-metadata-unavailable', 'Captured metadata chain has a gap or duplicate')
    const history = historyFor(source.scope, histories)
    const bound = history === null ? null : bindExternalRef(source, history)
    const [pin] = pins
    if (bound === null || !bound.ok || pin === undefined || canonicalValueDigest(bound.value.payload) !== pin.digest)
      return unavailable('accepted-metadata-unavailable', 'Captured metadata pin is not authenticated')
    latest = prefix
  }
  return { ok: true, value: latest }
}

function capturedPrefixAuthenticated(
  latest: AcceptedOwnSpec,
  captured: readonly RecordInputRef[],
  histories: readonly DecodedHistory[],
): boolean {
  for (const step of latest.chain) {
    const pins = captured.filter((pin) => pin.selector === '/payload' && sameRef(pin.record, step.source))
    const home = historyFor(step.source.scope, histories)
    const bound = home === null ? null : bindExternalRef(step.source, home)
    const [pin] = pins
    if (
      pins.length !== 1 ||
      bound === null ||
      !bound.ok ||
      pin === undefined ||
      pin.digest !== canonicalValueDigest(bound.value.payload)
    )
      return false
  }
  return true
}

function matchesMetadataState(latest: AcceptedOwnSpec, state: AssessSpecExact['accepted']): boolean {
  return sameAssessedState(
    {
      ref: latest.ref,
      snapshot: latest.snapshot,
      tier: latest.tier,
      children: latest.children,
      inheritedOwnSpecRefs: latest.inheritedOwnSpecRefs,
      coverage: latest.coverage,
    },
    state,
  )
}

function acceptedMetadata(
  chains: ReadonlyMap<string, Pick<Chain, 'prefixes'>>,
  histories: readonly DecodedHistory[],
  state: AssessSpecExact['accepted'],
  captured: readonly RecordInputRef[],
): ReturnType<CompatibilityOperandReader['acceptedMetadata']> {
  const candidates: AcceptedOwnSpec[] = []
  for (const chain of chains.values()) {
    const head = capturedMetadataHead(chain, state, captured, histories)
    if (!head.ok) return head
    const latest = head.value
    if (latest === undefined) continue
    if (!capturedPrefixAuthenticated(latest, captured, histories))
      return unavailable('accepted-metadata-unavailable', 'Captured metadata prefix is incomplete or unauthenticated')
    if (matchesMetadataState(latest, state)) candidates.push(latest)
  }
  const [candidate] = candidates
  return candidates.length === 1 && candidate !== undefined
    ? { ok: true, value: candidate }
    : unavailable('accepted-metadata-unavailable', 'Captured accepted metadata head is unavailable or ambiguous')
}

export function createCompatibilityOperands(
  chains: ReadonlyMap<string, Pick<Chain, 'prefixes'>>,
  histories: readonly DecodedHistory[],
): CompatibilityOperandReader {
  return {
    prefix(ref) {
      const matches = [...chains.values()].flatMap((chain) =>
        chain.prefixes.filter((prefix) => matchesAcceptedOrigin(prefix, ref)),
      )
      const [match] = matches
      return matches.length === 1 && match !== undefined
        ? { ok: true, value: match }
        : unavailable(
            'accepted-prefix-unavailable',
            'Accepted own origin is unavailable or ambiguous in the complete structural closure',
          )
    },
    acceptedMetadata(state, captured) {
      return acceptedMetadata(chains, histories, state, captured)
    },
  }
}
