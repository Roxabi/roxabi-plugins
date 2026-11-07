import { canonicalValueDigest } from './action-input.ts'
import { type CauseValidationFrame, currentCauseContext, historicalCauseContext } from './cause-validation-frame.ts'
import type { CauseContext } from './finding-target.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope } from './record-diagnostics.ts'
import type { Result } from './result.ts'
import { resolveSpecEffective } from './spec-effective.ts'
import type { UwGraphObservation } from './uw-graph.ts'

function authenticateContext(
  context: CauseContext,
  histories: readonly DecodedHistory[],
  graph: UwGraphObservation | null,
): Result<null> {
  if (!equalScope(context.original, context.effective.own.uw))
    return {
      ok: false,
      diagnostics: [diagnostic('cause-origin-mismatch', 'Cause origin differs from its effective Spec')],
    }
  const resolved =
    graph === null
      ? resolveSpecEffective({
          mode: 'historical',
          own: context.effective.own,
          versionVector: context.effective.versionVector,
          histories,
        })
      : resolveSpecEffective({ mode: 'current', own: context.effective.own, graph, histories })
  if (!resolved.ok || canonicalValueDigest(resolved.value) !== canonicalValueDigest(context.effective))
    return {
      ok: false,
      diagnostics: [
        diagnostic('cause-origin-unconfirmed', 'Effective Spec is not the exact authenticated accepted vector'),
      ],
    }
  return { ok: true, value: null }
}
export function authenticateCauseContext(
  context: CauseContext,
  histories: readonly DecodedHistory[],
  graph: UwGraphObservation,
): Result<null> {
  return authenticateContext(context, histories, graph)
}
export function authenticateHistoricalCauseContext(
  context: CauseContext,
  histories: readonly DecodedHistory[],
): Result<null> {
  return authenticateContext(context, histories, null)
}
export function authenticateFrameContext(
  frame: CauseValidationFrame,
  context: CauseContext,
  historical: boolean,
  graph?: UwGraphObservation,
): Result<null> {
  const key = canonicalValueDigest([context, historical, graph ?? null])
  const cached = frame.authorities.get(key)
  if (cached) return cached
  const resolved = historical
    ? historicalCauseContext(frame, context.effective.own, context.effective.versionVector)
    : graph === undefined
      ? null
      : currentCauseContext(frame, context.effective.own, context.effective.versionVector, graph)
  const result: Result<null> =
    resolved?.ok && canonicalValueDigest(resolved.value) === canonicalValueDigest(context)
      ? { ok: true, value: null }
      : {
          ok: false,
          diagnostics: [
            diagnostic(
              'cause-origin-unconfirmed',
              'The exact current or historical accepted vector is not authenticated',
            ),
          ],
        }
  frame.authorities.set(key, result)
  return result
}
