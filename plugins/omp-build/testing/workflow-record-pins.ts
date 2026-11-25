import { recordOperation } from '../adapters/github/record-integrity.ts'
import type { RecordInputRef } from '../engine/action-input-schema.ts'
import { canonicalValueDigest } from '../engine/canonical-value.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import { recordIntegrity } from '../engine/record-integrity.ts'
import type { ExternalRecordRef } from '../engine/record-references.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { Result } from '../engine/result.ts'
import { recordsOf } from '../engine/workflow-control.ts'
import { actionFailure } from '../roxabi/uw-action-result.ts'

function sameRecord(record: CanonicalRecord, ref: ExternalRecordRef): boolean {
  return (
    record.recordId === ref.recordId &&
    record.kind === ref.kind &&
    record.repository === ref.scope.repository &&
    record.target === ref.scope.target
  )
}

function authenticate(record: CanonicalRecord, home: readonly DecodedHistory[]): Result<CanonicalRecord> {
  const operation = recordOperation(home, record)
  if (operation === null)
    return actionFailure('record-unreadable', `${record.kind} ${record.recordId} has no native operation`)
  const refusal = recordIntegrity(operation.parts, record)
  if (refusal !== null) return actionFailure(refusal.reason, refusal.detail)
  if (operation.authority === 'foreign')
    return actionFailure('record-unreadable', `${record.kind} ${record.recordId} is not authenticated`)
  return { ok: true, value: record }
}

export function sourceRef(home: readonly DecodedHistory[], ref: ExternalRecordRef): Result<RecordInputRef> {
  for (const history of home) {
    for (const record of recordsOf(history)) {
      if (!sameRecord(record, ref)) continue
      const authenticated = authenticate(record, home)
      if (!authenticated.ok) return authenticated
      return {
        ok: true,
        value: { source: 'record', record: ref, selector: '/payload', digest: canonicalValueDigest(record.payload) },
      }
    }
  }
  return actionFailure('record-unreadable', 'Accepted source is absent from its scope')
}

export function pinAcceptedSources(
  histories: readonly DecodedHistory[],
  refs: readonly ExternalRecordRef[],
): Result<RecordInputRef[]> {
  const pins = new Map<string, RecordInputRef>()
  for (const ref of refs) {
    const pin = sourceRef(histories, ref)
    if (!pin.ok) return pin
    const key = JSON.stringify([pin.value.record, pin.value.selector])
    const previous = pins.get(key)
    if (previous !== undefined && canonicalValueDigest(previous) !== canonicalValueDigest(pin.value))
      return actionFailure('record-unreadable', 'Conflicting authenticated source pins')
    pins.set(key, pin.value)
  }
  return { ok: true, value: [...pins.values()] }
}
