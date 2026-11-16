import type { DecodedHistory, Scope } from '../dist/contracts.js'
import { bindExternalRef, canonicalValueDigest, commentAsPartPin, matchesCompletePin } from '../dist/contracts.js'
import type { PartPin, RecordPin } from '../engine/fix-recovery-identities.ts'
import type { FixActionResult } from './fix-contract.ts'
import { failure } from './fix-contract.ts'

/** Pin only the unique immutable complete record actually bound in a raw native history. */
export function pinRecoveryRecord<K extends 'workflow-binding' | 'mandate'>(input: {
  scope: Scope
  kind: K
  recordId: string
  histories: readonly DecodedHistory[]
}): FixActionResult<RecordPin<K>> {
  const homes = input.histories.filter(
    (history) =>
      history.source.scope.repository === input.scope.repository && history.source.scope.target === input.scope.target,
  )
  const history = homes[0]
  if (homes.length !== 1 || history === undefined || !history.source.complete)
    return failure('fix-recovery-pin-history-unavailable')
  const bound = bindExternalRef({ scope: input.scope, kind: input.kind, recordId: input.recordId }, history)
  if (!bound.ok || bound.value.kind !== input.kind) return failure('fix-recovery-pin-unconfirmed')
  const record = bound.value
  const matches = history.operations.filter(
    (operation) =>
      operation.authority !== 'foreign' &&
      (operation.operationId === record.operationId || operation.recordId === record.recordId),
  )
  const operation = matches[0]
  if (
    matches.length !== 1 ||
    operation === undefined ||
    operation.status !== 'complete' ||
    operation.record === null ||
    canonicalValueDigest(operation.record) !== canonicalValueDigest(record)
  )
    return failure('fix-recovery-pin-ambiguous')
  const parts = operation.parts.map(commentAsPartPin)
  if (parts.length === 0 || parts.some((part) => part === null)) return failure('fix-recovery-pin-unavailable')
  const pin: RecordPin<K> = {
    identity: {
      scope: input.scope,
      kind: input.kind,
      recordId: record.recordId,
      runId: record.runId,
      operationId: record.operationId,
    },
    envelopeDigest: canonicalValueDigest(record),
    parts: parts as PartPin[],
  }
  return matchesCompletePin(input.histories, pin) ? { ok: true, value: pin } : failure('fix-recovery-pin-unconfirmed')
}
