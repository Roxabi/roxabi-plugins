import { canonicalValueDigest } from './action-input.ts'
import { type CauseValidationFrame, currentCauseContext, historicalCauseContext } from './cause-validation-frame.ts'
import type { CauseContext } from './finding-target.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope } from './record-diagnostics.ts'
import type { Result } from './result.ts'
import { resolveOwnSpecEffective, sameOwnSpecRef } from './spec-effective.ts'
import { resolveAcceptedSpec, resolveAcceptedSpecAt } from './workflow-accepted-spec.ts'
import { bindExternalRef, recordsOf } from './workflow-control.ts'

function authenticateContext(
  context: CauseContext,
  histories: readonly DecodedHistory[],
  historical: boolean,
): Result<null> {
  if (!equalScope(context.original, context.effective.own.uw))
    return {
      ok: false,
      diagnostics: [diagnostic('cause-origin-mismatch', 'Original scope does not match the accepted Spec')],
    }
  const acceptedHistory = histories.find((item) =>
    equalScope(item.source.scope, context.effective.own.sourceAccepted.scope),
  )
  if (!acceptedHistory)
    return { ok: false, diagnostics: [diagnostic('missing-history', 'Accepted Spec source history is unavailable')] }
  const accepted = bindExternalRef(context.effective.own.sourceAccepted, acceptedHistory)
  if (!accepted.ok) return accepted
  const originHistory = histories.find((history) => equalScope(history.source.scope, context.original))
  const matchingSpec =
    originHistory &&
    recordsOf(originHistory).some((record) => {
      if (record.kind !== 'mandate') return false
      const resolved = historical
        ? resolveAcceptedSpecAt(record, histories, context.effective.own)
        : resolveAcceptedSpec(record, histories)
      if (!resolved.ok || !sameOwnSpecRef(resolved.spec.ref, context.effective.own)) return false
      const effective = resolveOwnSpecEffective(resolved.spec)
      return effective.ok && canonicalValueDigest(effective.value) === canonicalValueDigest(context.effective)
    })
  if (!matchingSpec)
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          'correction-spec-not-accepted',
          'Exact effective Spec cannot be reconstructed from authenticated accepted history',
        ),
      ],
    }
  return { ok: true, value: null }
}

export function authenticateCauseContext(context: CauseContext, histories: readonly DecodedHistory[]): Result<null> {
  return authenticateContext(context, histories, false)
}

export function authenticateHistoricalCauseContext(
  context: CauseContext,
  histories: readonly DecodedHistory[],
): Result<null> {
  return authenticateContext(context, histories, true)
}

export function authenticateFrameContext(
  frame: CauseValidationFrame,
  context: CauseContext,
  historical: boolean,
): Result<null> {
  const key = canonicalValueDigest([context, historical])
  const cached = frame.authorities.get(key)
  if (cached) return cached
  const result = authenticateBoundFrameContext(frame, context, historical)
  frame.authorities.set(key, result)
  return result
}

function authenticateBoundFrameContext(
  frame: CauseValidationFrame,
  context: CauseContext,
  historical: boolean,
): Result<null> {
  if (!equalScope(context.original, context.effective.own.uw))
    return {
      ok: false,
      diagnostics: [diagnostic('cause-origin-mismatch', 'Original scope does not match the accepted Spec')],
    }
  const history = frame.histories.find((item) =>
    equalScope(item.source.scope, context.effective.own.sourceAccepted.scope),
  )
  if (!history)
    return { ok: false, diagnostics: [diagnostic('missing-history', 'Accepted Spec source history is unavailable')] }
  const accepted = bindExternalRef(context.effective.own.sourceAccepted, history)
  if (!accepted.ok) return accepted
  const resolved = historical
    ? historicalCauseContext(frame, context.effective.own)
    : currentCauseContext(frame, context.effective.own)
  if (!resolved.ok || canonicalValueDigest(resolved.value) !== canonicalValueDigest(context))
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          'correction-spec-not-accepted',
          'Exact effective Spec cannot be reconstructed from authenticated accepted history',
        ),
      ],
    }
  return { ok: true, value: null }
}
