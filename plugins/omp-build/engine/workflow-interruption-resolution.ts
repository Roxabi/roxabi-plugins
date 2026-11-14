import { validateActionInputs } from './action-input.ts'
import { canonicalValueDigest } from './canonical-value.ts'
import type { DecodedHistory } from './history-schema.ts'
import { equalScope, fail, sameRef } from './record-diagnostics.ts'
import type { Diagnostic, Json } from './record-values.ts'
import type { Result } from './result.ts'
import {
  bindExternalRef,
  type ControlRecord,
  historyFor,
  type MandateRecord,
  type ReceiptRecord,
  scopedStartKey,
} from './workflow-control.ts'
import {
  authenticateInterruptedReceiptPair,
  INTERRUPTION_RESOLUTION_PREFIX,
  type InterruptionResolution,
  interruptionResolutionDigest,
  interruptionResolutionRecordId,
  invalidResolution,
  isInterruptionResolution,
  type ResolutionIndex,
  type ResolutionRecord,
} from './workflow-interruption-proof.ts'
import { operatorControlPayloadSchema } from './workflow-operator-control-schema.ts'

type Operation = DecodedHistory['operations'][number]
function receiptOperationUnreadable(operation: Operation): boolean {
  return (
    operation.authority !== 'foreign' &&
    (operation.record === null || operation.status !== 'complete') &&
    (operation.kind === 'action-receipt' || operation.claimedKinds.includes('action-receipt'))
  )
}

function admitStart(
  record: ResolutionRecord,
  home: DecodedHistory,
): Result<{ start: ReceiptRecord; result: ReceiptRecord | null }> {
  const payload = record.payload
  const refuse = (rule: string, message: string, detail: Json = {}) =>
    fail([invalidResolution(record.recordId, rule, message, detail)])
  const bound = bindExternalRef(payload.start, home)
  if (!bound.ok) return refuse('V10', 'Resolution START does not bind one authenticated record')
  const start = bound.value
  if (
    start.kind !== 'action-receipt' ||
    start.payload.phase !== 'start' ||
    start.payload.action !== payload.action ||
    start.payload.actionId !== payload.actionId ||
    !('scope' in start.payload.mandate) ||
    !sameRef(start.payload.mandate, payload.mandate) ||
    !validateActionInputs(start.payload.inputs).ok
  )
    return refuse('V2', 'Resolution START is not this mandate action invocation')
  if (home.operations.some(receiptOperationUnreadable))
    return refuse('V3', 'START history has an unreadable receipt operation')
  const operations = home.operations.filter(
    (operation) =>
      operation.authority !== 'foreign' &&
      operation.record?.kind === 'action-receipt' &&
      operation.record.payload.action === payload.action &&
      operation.record.payload.actionId === payload.actionId,
  )
  if (operations.some((operation) => operation.authority !== 'accounted' || operation.status !== 'complete'))
    return refuse('V3', 'Invocation operations are not complete')
  const receipts = new Map<string, ReceiptRecord>()
  for (const operation of operations)
    if (operation.record?.kind === 'action-receipt') receipts.set(operation.record.recordId, operation.record)
  const starts = [...receipts.values()].filter((receipt) => receipt.payload.phase === 'start')
  const results = [...receipts.values()].filter((receipt) => receipt.payload.phase === 'result')
  if (starts.length !== 1 || starts[0]?.recordId !== start.recordId)
    return refuse('V3', 'Invocation START pairing is ambiguous')
  if (results.length > 1) return refuse('V3', 'Invocation has competing RESULTs')
  const result = results[0] ?? null
  return admitStartResult(record, home, start, result)
}

function admitStartResult(
  record: ResolutionRecord,
  home: DecodedHistory,
  start: ReceiptRecord,
  result: ReceiptRecord | null,
): Result<{ start: ReceiptRecord; result: ReceiptRecord | null }> {
  const payload = record.payload
  const refuse = (rule: string, message: string, detail: Json = {}) =>
    fail([invalidResolution(record.recordId, rule, message, detail)])
  if (payload.result === null) {
    if (result !== null)
      return refuse('V3', 'Invocation has a RESULT the resolution does not cite', {
        cause: 'late-result',
        result: result.recordId,
      })
    return { ok: true, value: { start, result: null } }
  }
  if (
    result === null ||
    payload.result.kind !== 'action-receipt' ||
    !equalScope(payload.result.scope, payload.start.scope) ||
    payload.result.recordId !== result.recordId
  )
    return refuse('V3', 'Resolution does not cite the unique RESULT of its START', { cause: 'late-result' })
  const boundResult = bindExternalRef(payload.result, home)
  if (!boundResult.ok || canonicalValueDigest(boundResult.value) !== canonicalValueDigest(result))
    return refuse('V10', 'Resolution RESULT does not bind one authenticated record')
  if (!authenticateInterruptedReceiptPair(home, result).ok)
    return refuse('V3', 'Cited RESULT is not an authenticated typed interrupted RESULT')
  return { ok: true, value: { start, result } }
}

function admitAuthority(
  record: ResolutionRecord,
  histories: readonly DecodedHistory[],
): Result<{ mandate: MandateRecord; pause: ControlRecord }> {
  const payload = record.payload
  const refuse = (rule: string, message: string) => fail([invalidResolution(record.recordId, rule, message)])
  const mandateHome = historyFor(payload.mandate.scope, histories)
  const boundMandate = mandateHome === null ? null : bindExternalRef(payload.mandate, mandateHome)
  if (boundMandate === null || !boundMandate.ok || boundMandate.value.kind !== 'mandate')
    return refuse('V10', 'Resolution mandate does not bind one authenticated mandate')
  const mandate = boundMandate.value
  const pauseHome = historyFor(payload.predecessor.scope, histories)
  const boundPause = pauseHome === null ? null : bindExternalRef(payload.predecessor, pauseHome)
  if (boundPause === null || !boundPause.ok || boundPause.value.kind !== 'operator-control')
    return refuse('V10', 'Resolution predecessor does not bind one authenticated control')
  const pause = boundPause.value
  if (
    pause.payload.control !== 'pause-confirmed' ||
    !sameRef(pause.payload.mandate, payload.mandate) ||
    pause.payload.disarm.observed !== true
  )
    return refuse('V4', 'Resolution predecessor is not a confirmed pause of its mandate')
  const config = mandate.payload.config
  if (
    payload.runtime.productVersion !== config.productVersion ||
    payload.runtime.configVersion !== config.version ||
    payload.runtime.configDigest !== config.digest
  )
    return refuse('V5', 'Resolution runtime differs from the mandate configuration')
  return { ok: true, value: { mandate, pause } }
}

function admitWithin(record: ResolutionRecord, histories: readonly DecodedHistory[]): Result<InterruptionResolution> {
  const payload = record.payload
  const refuse = (rule: string, message: string) => fail([invalidResolution(record.recordId, rule, message)])
  if (!operatorControlPayloadSchema.safeParse(payload).success)
    return refuse('V1', 'Resolution payload is not a safe-stop control')
  const scope = { repository: record.repository, target: record.target }
  const { proposalDigest, confirmation, ...proposal } = payload
  if (
    payload.start.kind !== 'action-receipt' ||
    !equalScope(payload.start.scope, scope) ||
    record.recordId !== interruptionResolutionRecordId(payload.start.recordId)
  )
    return refuse('V1', 'Resolution identity is not derived from its exact START')
  if (
    payload.controlId !== record.operationId ||
    confirmation.operationId !== record.operationId ||
    confirmation.proposalDigest !== proposalDigest ||
    interruptionResolutionDigest(proposal) !== proposalDigest
  )
    return refuse('V1', 'Resolution confirmation does not bind this exact proposal')
  const home = historyFor(scope, histories)
  if (home === null || !home.source.complete) return refuse('V3', 'START history is missing or incomplete')
  const pair = admitStart(record, home)
  if (!pair.ok) return pair
  const authority = admitAuthority(record, histories)
  if (!authority.ok) return authority
  return {
    ok: true,
    value: {
      record,
      mandate: authority.value.mandate,
      start: pair.value.start,
      result: pair.value.result,
      pause: authority.value.pause,
    },
  }
}

/** Authenticate one resolution and every ref it carries against the full histories. */
export function admitInterruptionResolution(
  record: ResolutionRecord,
  histories: readonly DecodedHistory[],
): Result<InterruptionResolution> {
  return admitWithin(record, histories)
}

function resolutionOperation(operation: Operation): boolean {
  if (operation.authority === 'foreign') return false
  if (isInterruptionResolution(operation.record)) return true
  return (operation.recordId ?? operation.record?.recordId ?? '').startsWith(INTERRUPTION_RESOLUTION_PREFIX)
}

/**
 * Index every resolution of the supplied histories, rebuilt per call. Any incomplete, invalid or competing
 * resolution operation is a problem: host fences and selectors then fail closed.
 */
export function resolutionIndex(histories: readonly DecodedHistory[]): Result<ResolutionIndex> {
  const problems: Diagnostic[] = []
  const resolved = new Map<string, InterruptionResolution>()
  const observed = new Map<string, string>()
  for (const { history, operation } of histories.flatMap((history) =>
    history.operations.map((operation) => ({ history, operation })),
  )) {
    if (!resolutionOperation(operation)) continue
    const record = operation.record
    if (!isInterruptionResolution(record) || !authenticatedResolutionOperation(history, operation, record)) {
      problems.push(invalidResolution(operation.recordId, 'V3', 'Resolution operation ownership is not authenticated'))
      continue
    }
    if (!observeResolutionCopy(record, observed, problems)) continue
    const admitted = admitInterruptionResolution(record, histories)
    if (!admitted.ok) {
      problems.push(...admitted.diagnostics)
      continue
    }
    const key = scopedStartKey(record.payload.start)
    if (resolved.has(key)) {
      problems.push(invalidResolution(record.recordId, 'V3', 'Several resolutions name one START'))
      continue
    }
    resolved.set(key, admitted.value)
  }
  return problems.length > 0 ? fail(problems) : { ok: true, value: { resolved } }
}

function observeResolutionCopy(
  record: ResolutionRecord,
  observed: Map<string, string>,
  problems: Diagnostic[],
): boolean {
  const identity = scopedStartKey({
    scope: { repository: record.repository, target: record.target },
    recordId: record.recordId,
  })
  const digest = canonicalValueDigest(record)
  const prior = observed.get(identity)
  if (prior !== undefined) {
    if (prior !== digest) problems.push(invalidResolution(record.recordId, 'V3', 'Resolution has incompatible copies'))
    return false
  }
  observed.set(identity, digest)
  return true
}

function authenticatedResolutionOperation(
  history: DecodedHistory,
  operation: Operation,
  record: ResolutionRecord,
): boolean {
  if (
    operation.status !== 'complete' ||
    operation.authority !== 'accounted' ||
    operation.recordId !== record.recordId ||
    operation.operationId !== record.operationId
  )
    return false
  const owners = history.operations.filter(
    (candidate) => candidate.authority !== 'foreign' && candidate.operationId === record.operationId,
  )
  return owners.length === 1
}
