import { canonicalValueDigest } from './action-input.ts'
import type { CauseDispositionPayload } from './cause-disposition-schema.ts'
import type { CauseContext } from './finding-target.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic } from './record-diagnostics.ts'
import type { Diagnostic } from './record-values.ts'
import type { Result } from './result.ts'
import type { ReviewClassCatalogues } from './review-class-catalogue.ts'
import type { DecisionBindings } from './review-decision.ts'
import { resolveSpecEffective } from './spec-effective.ts'
import type { SpecVersionVector } from './uw-completion-types.ts'
import type { UwGraphObservation } from './uw-graph.ts'
import type { OwnSpecRef } from './uw-spec-schema.ts'
import type { AcceptedOwnSpec } from './workflow-accepted-spec-types.ts'

/** Never retain this frame across observations; its evidence is the supplied immutable snapshot. */
export type CauseValidationFrame = {
  histories: readonly DecodedHistory[]
  readonly catalogues: ReviewClassCatalogues
  chains: Map<string, readonly AcceptedOwnSpec[] | null>
  authorities: Map<string, Result<null>>
  adjudications: Map<string, readonly Diagnostic[]>
  confirmations: Set<string>
  bindings: Map<string, DecisionBindings>
  contexts: Map<string, Result<CauseContext>>
  transitions: Map<string, Result<CauseDispositionPayload>>
}
export function causeValidationFrame(
  histories: readonly DecodedHistory[],
  catalogues: ReviewClassCatalogues,
): CauseValidationFrame {
  return {
    histories,
    catalogues,
    chains: new Map(),
    authorities: new Map(),
    adjudications: new Map(),
    confirmations: new Set(),
    bindings: new Map(),
    contexts: new Map(),
    transitions: new Map(),
  }
}
export function historicalCauseContext(
  frame: CauseValidationFrame,
  origin: OwnSpecRef,
  versionVector: SpecVersionVector,
): Result<CauseContext> {
  const key = canonicalValueDigest(['historical', origin, versionVector])
  const cached = frame.contexts.get(key)
  if (cached) return cached
  const resolved = resolveSpecEffective({ mode: 'historical', own: origin, versionVector, histories: frame.histories })
  const result: Result<CauseContext> = resolved.ok
    ? { ok: true, value: { original: origin.uw, effective: resolved.value } }
    : { ok: false, diagnostics: resolved.diagnostics.map((item) => diagnostic(item.code, item.message)) }
  frame.contexts.set(key, result)
  return result
}
export function currentCauseContext(
  frame: CauseValidationFrame,
  origin: OwnSpecRef,
  versionVector: SpecVersionVector,
  graph: UwGraphObservation,
): Result<CauseContext> {
  const key = canonicalValueDigest(['current', origin, versionVector, graph])
  const cached = frame.contexts.get(key)
  if (cached) return cached
  const resolved = resolveSpecEffective({ mode: 'current', own: origin, graph, histories: frame.histories })
  const result: Result<CauseContext> =
    resolved.ok && canonicalValueDigest(resolved.value.versionVector) === canonicalValueDigest(versionVector)
      ? { ok: true, value: { original: origin.uw, effective: resolved.value } }
      : {
          ok: false,
          diagnostics: [
            diagnostic(
              'cause-origin-unconfirmed',
              'Current accepted vector is unavailable or differs from the supplied context',
            ),
          ],
        }
  frame.contexts.set(key, result)
  return result
}
