import { canonicalValueDigest } from './action-input.ts'
import type { CauseContext } from './finding-target.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope } from './record-diagnostics.ts'
import type { Result } from './result.ts'
import { resolveOwnSpecEffective, sameOwnSpecRef } from './spec-effective.ts'
import { resolveAcceptedSpec } from './workflow-accepted-spec.ts'
import { bindExternalRef, recordsOf } from './workflow-control.ts'

export function authenticateCauseContext(context: CauseContext, histories: readonly DecodedHistory[]): Result<null> {
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
      const resolved = resolveAcceptedSpec(record, histories)
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
