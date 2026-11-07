import { bindExternalRef } from '../dist/contracts.js'
import type { RecordInputRef } from '../engine/action-input-schema.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { Result } from '../engine/result.ts'
import { actionFailure } from './uw-action-result.ts'

function confirmCitedRef(ref: RecordInputRef, histories: readonly DecodedHistory[]): Result<true> {
  const matches = histories.filter(
    (item) =>
      item.source.scope.repository === ref.record.scope.repository &&
      item.source.scope.target === ref.record.scope.target,
  )
  if (matches.length !== 1 || matches[0] === undefined)
    return actionFailure(
      'record-unreadable',
      `Cited scope ${ref.record.scope.repository} ${ref.record.scope.target} is missing or conflicting`,
    )
  const bound = bindExternalRef(ref.record, matches[0])
  return bound.ok ? { ok: true, value: true } : { ok: false, diagnostics: bound.diagnostics }
}

export function confirmCitedRefs(refs: readonly RecordInputRef[], histories: readonly DecodedHistory[]): Result<true> {
  for (const ref of refs) {
    const confirmed = confirmCitedRef(ref, histories)
    if (!confirmed.ok) return confirmed
  }
  return { ok: true, value: true }
}
