import {
  bindExternalRef,
  canonicalValueDigest,
  historyFor,
  recordOperation,
  recordsOf,
  validateActionInputs,
} from '../dist/contracts.js'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { Result } from '../engine/result.ts'
import type { UwActionRequest } from './uw-action-contract.ts'
import { authenticate } from './uw-action-observe.ts'
import { actionFailure } from './uw-action-result.ts'

const equal = (a: unknown, b: unknown) => canonicalValueDigest(a) === canonicalValueDigest(b)
export type Receipt = Extract<CanonicalRecord, { kind: 'action-receipt' }>
export type Family = 'frame' | 'assess-spec' | 'attribute-ci' | 'implement'
export type Negative = Receipt & { payload: Extract<Receipt['payload'], { action: Family; phase: 'result' }> }

export function authenticateNegative(
  result: Negative,
  request: UwActionRequest,
  histories: readonly DecodedHistory[],
): Result<true> {
  const body = result.payload
  if (
    body.actionId === request.actionId ||
    body.native.completion !== 'completed' ||
    body.native.strict !== 'valid' ||
    body.admission !== null
  )
    return actionFailure('record-unreadable', 'Negative result is not an authenticated terminal')
  const resultHistory = historyFor({ repository: result.repository, target: result.target }, histories)
  const startHistory = historyFor(body.start.scope, histories)
  if (
    recordOperation(histories, result)?.authority !== 'accounted' ||
    !authenticate(result, histories).ok ||
    resultHistory === null ||
    startHistory === null ||
    !bindExternalRef({ scope: resultHistory.source.scope, kind: result.kind, recordId: result.recordId }, resultHistory)
      .ok ||
    !bindExternalRef(body.start, startHistory).ok
  )
    return actionFailure('record-unreadable', 'Negative result is not bound to authenticated history')
  return { ok: true, value: true }
}

export function authenticateStart(result: Negative, histories: readonly DecodedHistory[]): Result<Receipt> {
  const records = histories.flatMap(recordsOf)
  const body = result.payload
  const starts = records.filter(
    (record) =>
      record.kind === 'action-receipt' &&
      record.payload.phase === 'start' &&
      record.recordId === body.start.recordId &&
      record.repository === body.start.scope.repository &&
      record.target === body.start.scope.target,
  )
  const start = starts[0]
  if (
    starts.length !== 1 ||
    start?.kind !== 'action-receipt' ||
    start.payload.phase !== 'start' ||
    start.payload.action !== body.action ||
    start.payload.actionId !== body.actionId ||
    !equal(start.payload.exactInputs, body.exactInputs) ||
    !equal(start.payload.mandate, body.mandate) ||
    !equal(start.payload.inputs, body.inputs) ||
    recordOperation(histories, start)?.authority !== 'accounted' ||
    !authenticate(start, histories).ok ||
    !validateActionInputs(body.inputs).ok
  )
    return actionFailure('record-unreadable', 'Negative result does not match its accounted start')
  return { ok: true, value: start }
}
