import { canonicalValueDigest } from './action-input.ts'
import type { CauseDispositionPayload } from './cause-disposition-schema.ts'
import type { CauseContext } from './finding-target.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Diagnostic } from './record-values.ts'
import type { Result } from './result.ts'
import { resolveOwnSpecEffective, sameOwnSpecRef } from './spec-effective.ts'
import type { OwnSpecRef } from './uw-spec-schema.ts'
import { resolveAcceptedSpecPrefixes } from './workflow-accepted-spec.ts'
import type { AcceptedOwnSpec } from './workflow-accepted-spec-types.ts'
import { recordsOf } from './workflow-control.ts'

/** Never retain this frame across observations; its evidence is the supplied immutable snapshot. */
export type CauseValidationFrame = {
  histories: readonly DecodedHistory[]
  chains: Map<string, readonly AcceptedOwnSpec[] | null>
  authorities: Map<string, Result<null>>
  adjudications: Map<string, readonly Diagnostic[]>
  confirmations: Set<string>
  contexts: Map<string, Result<CauseContext>>
  transitions: Map<string, Result<CauseDispositionPayload>>
}

export function causeValidationFrame(histories: readonly DecodedHistory[]): CauseValidationFrame {
  return {
    histories,
    chains: new Map(),
    contexts: new Map(),
    transitions: new Map(),
    authorities: new Map(),
    adjudications: new Map(),
    confirmations: new Set(),
  }
}

function resolveFrameContext(
  frame: CauseValidationFrame,
  origin: OwnSpecRef,
  historical: boolean,
): Result<CauseContext> {
  const key = canonicalValueDigest([origin, historical])
  const cached = frame.contexts.get(key)
  if (cached) return cached
  const matches = matchingContexts(frame, origin, historical)
  const value: Result<CauseContext> =
    matches.length === 1 && matches[0] !== undefined
      ? { ok: true, value: matches[0] }
      : {
          ok: false,
          diagnostics: [
            diagnostic('cause-origin-unconfirmed', 'A unique authenticated accepted Spec prefix is required'),
          ],
        }
  frame.contexts.set(key, value)
  return value
}

function acceptedChain(
  frame: CauseValidationFrame,
  mandate: Extract<CanonicalRecord, { kind: 'mandate' }>,
): readonly AcceptedOwnSpec[] | null {
  const key = canonicalValueDigest(mandate)
  const cached = frame.chains.get(key)
  if (cached !== undefined) return cached
  const resolved = resolveAcceptedSpecPrefixes(mandate, frame.histories)
  const chain = resolved.ok ? resolved.prefixes : null
  frame.chains.set(key, chain)
  return chain
}

function matchingContexts(frame: CauseValidationFrame, origin: OwnSpecRef, historical: boolean): CauseContext[] {
  const history = frame.histories.find((item) => equalScope(item.source.scope, origin.uw))
  const matches: CauseContext[] = []
  for (const record of history ? recordsOf(history) : []) {
    if (record.kind !== 'mandate') continue
    matches.push(...matchingMandateContexts(frame, record, origin, historical))
  }
  return matches
}

function matchingMandateContexts(
  frame: CauseValidationFrame,
  mandate: Extract<CanonicalRecord, { kind: 'mandate' }>,
  origin: OwnSpecRef,
  historical: boolean,
): CauseContext[] {
  const chain = acceptedChain(frame, mandate)
  const candidates = historical ? (chain ?? []) : (chain?.slice(-1) ?? [])
  const matches: CauseContext[] = []
  for (const spec of candidates) {
    if (!sameOwnSpecRef(spec.ref, origin)) continue
    const effective = resolveOwnSpecEffective(spec)
    if (effective.ok) matches.push({ original: origin.uw, effective: effective.value })
  }
  return matches
}

export function historicalCauseContext(frame: CauseValidationFrame, origin: OwnSpecRef): Result<CauseContext> {
  return resolveFrameContext(frame, origin, true)
}

export function currentCauseContext(frame: CauseValidationFrame, origin: OwnSpecRef): Result<CauseContext> {
  return resolveFrameContext(frame, origin, false)
}
