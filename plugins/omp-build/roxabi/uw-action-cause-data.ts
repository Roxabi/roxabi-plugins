import { causeDispositionLineage, historyFor, readCauseDispositionHeads } from '../dist/contracts.js'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { ExternalRecordRef } from '../engine/record-references.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { Result } from '../engine/result.ts'
import type { DeliveryDataRef, RecordInputRef, UwActionRequest } from './uw-action-contract.ts'
import { sourceRef } from './uw-action-observe.ts'
import { actionFailure } from './uw-action-result.ts'

type Disposition = Extract<CanonicalRecord, { kind: 'cause-disposition' }>
type CauseStateRecord = Extract<CanonicalRecord, { kind: 'cause-disposition' | 'cause-operation' }>

function sourceOfDisposition(head: Disposition): ExternalRecordRef {
  const subject = head.payload.subject
  if (subject.kind === 'cause') return subject.decision
  return subject.kind === 'retained-finding' ? subject.contribution : subject.source
}

function appendPin(
  record: CauseStateRecord,
  histories: readonly DecodedHistory[],
  refs: DeliveryDataRef[],
): Result<true> {
  const pinned = sourceRef(histories, {
    scope: { repository: record.repository, target: record.target },
    kind: record.kind,
    recordId: record.recordId,
  })
  if (!pinned.ok) return pinned
  refs.push({ ...pinned.value, role: 'cause-state' })
  return { ok: true, value: true }
}

function appendLineage(
  head: Disposition,
  own: DecodedHistory,
  histories: readonly DecodedHistory[],
  refs: DeliveryDataRef[],
): Result<true> {
  const lineage = causeDispositionLineage({ head, history: own })
  if (!lineage.ok) return lineage
  for (const { disposition, adjudication } of lineage.value) {
    const pinned = appendPin(disposition, histories, refs)
    if (!pinned.ok) return pinned
    if (adjudication !== null) {
      const operation = appendPin(adjudication, histories, refs)
      if (!operation.ok) return operation
    }
  }
  return { ok: true, value: true }
}

function currentOutput(ref: ExternalRecordRef, outputs: readonly RecordInputRef[]): boolean {
  return outputs.some(
    (output) =>
      output.record.scope.repository === ref.scope.repository &&
      output.record.scope.target === ref.scope.target &&
      output.record.kind === ref.kind &&
      output.record.recordId === ref.recordId,
  )
}

/** Prior cause state is normative input; the current root's own dispositions are output. */
export function causeActionData(
  request: UwActionRequest,
  histories: readonly DecodedHistory[],
  currentOutputs: readonly RecordInputRef[],
): Result<DeliveryDataRef[]> {
  if (request.subject.kind !== 'uw' || (request.purpose !== 'review' && request.purpose !== 'correction'))
    return { ok: true, value: [] }
  const heads = readCauseDispositionHeads({ uw: request.subject.uw, histories })
  if (!heads.ok) return heads
  const refs: DeliveryDataRef[] = []
  const own = historyFor(request.subject.uw, histories)
  if (own === null) return actionFailure('record-unreadable', 'Cause state has no original UW history')
  for (const head of heads.value) {
    if (currentOutput(sourceOfDisposition(head), currentOutputs)) continue
    const lineage = appendLineage(head, own, histories, refs)
    if (!lineage.ok) return lineage
  }
  return { ok: true, value: refs }
}
