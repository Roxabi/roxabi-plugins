import { recordIntegrity, recordOperation, recordsOf } from '../dist/contracts.js'
import type { RecordInputRef } from '../engine/action-input-schema.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { Result } from '../engine/result.ts'
import { actionFailure } from './uw-action-result.ts'

function confirmAccounted(matched: DecodedHistory, record: CanonicalRecord): Result<true> {
  const operation = recordOperation([matched], record)
  if (operation === null || operation.authority !== 'accounted')
    return actionFailure(
      'record-unreadable',
      `Cited ${record.kind} ${record.recordId} is not an accounted native operation`,
    )
  const refusal = recordIntegrity(operation.parts, record)
  if (refusal !== null) return actionFailure(refusal.reason, refusal.detail)
  return { ok: true, value: true }
}

function confirmCitedRef(
  ref: RecordInputRef,
  history: DecodedHistory,
  histories: readonly DecodedHistory[],
): Result<true> {
  if (
    ref.record.scope.repository === history.source.scope.repository &&
    ref.record.scope.target === history.source.scope.target
  )
    return { ok: true, value: true }
  const matched = histories.find(
    (item) =>
      item.source.scope.repository === ref.record.scope.repository &&
      item.source.scope.target === ref.record.scope.target,
  )
  if (matched === undefined)
    return actionFailure('record-unreadable', `Cited ${ref.record.kind} ${ref.record.recordId} has no external history`)
  const record = recordsOf(matched).find(
    (candidate) => candidate.recordId === ref.record.recordId && candidate.kind === ref.record.kind,
  )
  if (record === undefined)
    return actionFailure(
      'record-unreadable',
      `Cited ${ref.record.kind} ${ref.record.recordId} is absent from ${ref.record.scope.repository} ${ref.record.scope.target}`,
    )
  return confirmAccounted(matched, record)
}

export function confirmCitedRefs(
  refs: readonly RecordInputRef[],
  history: DecodedHistory,
  histories: readonly DecodedHistory[],
): Result<true> {
  for (const ref of refs) {
    const confirmed = confirmCitedRef(ref, history, histories)
    if (!confirmed.ok) return confirmed
  }
  return { ok: true, value: true }
}
