import { canonicalValueDigest, validateActionInputs } from './action-input.ts'
import { authenticateHistoricalActionInputs } from './historical-action-inputs.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope } from './record-diagnostics.ts'
import type { Diagnostic } from './record-values.ts'
import { workflowContextNegative } from './workflow-context-output.ts'
import { reviewContextPairValid } from './workflow-context-review.ts'
import { bindExternalRef, type ReceiptRecord } from './workflow-control.ts'

type PairStage = 'result' | 'start' | 'identity' | 'capture' | 'manifest'
type Pair =
  | { ok: true; value: { start: ReceiptRecord; result: ReceiptRecord } }
  | { ok: false; stage: PairStage; diagnostics: Diagnostic[] }

type ReceiptResult = Extract<ReceiptRecord['payload'], { phase: 'result' }>

function sameCapture(start: ReceiptRecord, result: ReceiptRecord, payload: ReceiptResult): boolean {
  return (
    start.payload.phase === 'start' &&
    start.payload.action === payload.action &&
    start.payload.actionId === payload.actionId &&
    canonicalValueDigest(start.payload.mandate) === canonicalValueDigest(payload.mandate) &&
    canonicalValueDigest(start.payload.exactInputs) === canonicalValueDigest(payload.exactInputs) &&
    canonicalValueDigest(start.payload.inputs) === canonicalValueDigest(payload.inputs) &&
    reviewContextPairValid(start, result, workflowContextNegative(result))
  )
}

function competingReceipt(history: DecodedHistory, result: ReceiptRecord, payload: ReceiptResult): boolean {
  const mandate = canonicalValueDigest(payload.mandate)
  return history.operations.some(({ authority, record }) => {
    if (
      authority === 'foreign' ||
      record?.kind !== 'action-receipt' ||
      record.recordId === payload.start.recordId ||
      record.recordId === result.recordId ||
      record.payload.action !== payload.action ||
      record.payload.actionId !== payload.actionId ||
      canonicalValueDigest(record.payload.mandate) !== mandate
    )
      return false
    return bindExternalRef({ ...payload.start, recordId: record.recordId }, history).ok
  })
}

function authenticateCapture(
  payload: ReceiptResult,
  histories: readonly DecodedHistory[],
  structural: boolean,
): Diagnostic[] {
  if (structural) {
    const valid = validateActionInputs(payload.inputs)
    return valid.ok ? [] : valid.diagnostics
  }
  const main = authenticateHistoricalActionInputs(payload.inputs, histories)
  if (!main.ok) return main.diagnostics
  if (payload.action === 'plan-review') {
    for (const slot of payload.slots) {
      if (slot.action == null) continue
      const checked = authenticateHistoricalActionInputs(slot.action.inputs, histories)
      if (!checked.ok) return checked.diagnostics
    }
  }
  return []
}

/** Authenticate exact historical action-receipt lineage, independent of the consumer's native outcome policy. */
export function authenticateHistoricalReceiptStart(
  history: DecodedHistory,
  result: ReceiptRecord,
  histories: readonly DecodedHistory[] = [history],
  options: { inputs: 'authenticated' | 'structural' } = { inputs: 'authenticated' },
): Pair {
  const payload = result.payload
  if (payload.phase !== 'result') {
    return { ok: false, stage: 'result', diagnostics: [diagnostic('unconfirmed', 'Expected a historical RESULT')] }
  }
  const scope = history.source.scope
  const action =
    payload.action === 'implement' ? 'implementation' : payload.action === 'integrate' ? 'integration' : payload.action
  const denied = (stage: PairStage, message: string, details: Diagnostic[] = []): Pair => ({
    ok: false,
    stage,
    diagnostics: [
      diagnostic(`${action}-start-unpaired`, `${payload.action} ${payload.actionId}: ${message}`, {
        start: payload.start,
        resultScope: scope,
      }),
      ...details,
    ],
  })
  if (!equalScope(result, scope)) return denied('result', 'RESULT is not in its native scope')
  const observedResult = bindExternalRef({ scope, kind: 'action-receipt', recordId: result.recordId }, history)
  if (!observedResult.ok) return denied('result', 'RESULT cannot be authenticated', observedResult.diagnostics)
  if (
    observedResult.value.kind !== 'action-receipt' ||
    canonicalValueDigest(observedResult.value) !== canonicalValueDigest(result)
  )
    return denied('result', 'RESULT does not match its native readback')
  if (payload.start.kind !== 'action-receipt' || !equalScope(payload.start.scope, scope))
    return denied('identity', 'START must be an action receipt in the RESULT history')
  const start = bindExternalRef(payload.start, history)
  if (!start.ok) return denied('start', 'Cited START cannot be authenticated', start.diagnostics)
  if (
    start.value.kind !== 'action-receipt' ||
    start.value.recordId !== payload.start.recordId ||
    !equalScope(start.value, scope) ||
    !sameCapture(start.value, result, payload)
  )
    return denied(
      'capture',
      'Cited START does not match the RESULT action, mandate, exact inputs, and complete capture',
    )
  if (competingReceipt(history, result, payload))
    return denied('identity', 'RESULT has a competing authenticated receipt for the same invocation')
  const problems = authenticateCapture(payload, histories, options.inputs === 'structural')
  if (problems.length !== 0) return denied('manifest', 'START inputs are not authenticated', problems)
  return { ok: true, value: { start: start.value, result: observedResult.value } }
}
