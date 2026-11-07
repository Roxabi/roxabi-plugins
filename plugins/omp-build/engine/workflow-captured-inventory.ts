import { canonicalValueDigest } from './action-input.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope } from './record-diagnostics.ts'
import type { Result } from './result.ts'
import type { AcceptedOwnSpec } from './workflow-accepted-spec-types.ts'
import { authenticateCapturedWorkFrame } from './workflow-captured-frame.ts'
import { workflowCausalDiagnostics } from './workflow-chantier.ts'
import { authenticateWorkflowReceiptPair, workflowContextTerminal } from './workflow-context-terminal.ts'
import { type MandateRecord, type ReceiptRecord, workflowOperationProblem } from './workflow-control.ts'
import type { WorkflowEvidence } from './workflow-plan.ts'
import type { AssessmentReplayContext } from './workflow-spec-authentication.ts'

export type CapturedInvocation = {
  history: DecodedHistory
  start: ReceiptRecord
  result: ReceiptRecord
  frame: { mandate: MandateRecord; prefix: AcceptedOwnSpec }
}
const inspected: Record<string, true> = { plan: true, 'plan-review': true, implement: true, integrate: true }

const fail = (message: string): Result<never> => ({ ok: false, diagnostics: [diagnostic('unconfirmed', message)] })

function addOperationIdentities(identities: Set<string>, operation: DecodedHistory['operations'][number]): boolean {
  for (const identity of [
    operation.operationId === null ? null : `operation:${operation.operationId}`,
    operation.recordId === null ? null : `record:${operation.recordId}`,
  ]) {
    if (identity === null) continue
    if (identities.has(identity)) return false
    identities.add(identity)
  }
  return true
}

function validateHistoryOperationIdentities(history: DecodedHistory): Result<void> {
  if (workflowOperationProblem(history) !== null)
    return fail('Captured work history has an incomplete or invalid owned operation')
  const identities = new Set<string>()
  for (const operation of history.operations) {
    if (operation.authority === 'foreign') continue
    if (!addOperationIdentities(identities, operation))
      return fail('Captured work has competing native operation identities')
  }
  return { ok: true, value: undefined }
}

function validateOperationIdentities(histories: readonly DecodedHistory[]): Result<void> {
  for (const history of histories) {
    const result = validateHistoryOperationIdentities(history)
    if (!result.ok) return result
  }
  return { ok: true, value: undefined }
}

function validateStarts(receipts: readonly ReceiptRecord[]): Result<void> {
  for (const start of receipts.filter((record) => record.payload.phase === 'start')) {
    const matching = receipts.filter(
      (record) =>
        record.payload.phase === 'result' &&
        record.payload.action === start.payload.action &&
        record.payload.actionId === start.payload.actionId,
    )
    if (matching.length !== 1) return fail('Captured invocation has no unique result')
  }
  return { ok: true, value: undefined }
}

function authenticateInvocation(
  history: DecodedHistory,
  result: ReceiptRecord,
  evidence: WorkflowEvidence,
  replay?: AssessmentReplayContext,
): Result<CapturedInvocation> {
  const pair = authenticateWorkflowReceiptPair(history, result)
  if (!pair.ok) return pair
  const payload = result.payload
  if (
    payload.phase !== 'result' ||
    (payload.action !== 'plan' &&
      payload.action !== 'plan-review' &&
      payload.action !== 'implement' &&
      payload.action !== 'integrate') ||
    payload.inputs.manifest.purpose !== payload.action
  )
    return fail('Captured invocation purpose differs from its receipt')
  const operands = payload.inputs.manifest.operands
  if (
    payload.action === 'integrate' &&
    (operands?.action !== 'integrate' ||
      canonicalValueDigest(operands.exactInputs) !== canonicalValueDigest(payload.exactInputs))
  )
    return fail('Captured integration operands differ from its sealed manifest')
  const subject = payload.inputs.manifest.subject
  if (subject.kind !== 'uw' || !equalScope(subject.uw, evidence.issue.source.scope))
    return fail('Captured invocation belongs to another UW')
  const code = payload.inputs.manifest.code
  const expected = payload.action === 'plan' || payload.action === 'plan-review' ? code.base : code.head
  if (code.referenceCommit !== expected) return fail('Captured invocation code reference is not the action reference')
  const frame = authenticateCapturedWorkFrame(payload.inputs, payload.mandate, evidence.causal.histories, replay)
  if (!frame.ok) return frame
  return { ok: true, value: { history, start: pair.value.start, result, frame: frame.value } }
}

function validateTerminalContexts(history: DecodedHistory): Result<void> {
  for (const action of Object.keys(inspected)) {
    if (workflowContextTerminal(history, action) !== 'clear')
      return fail('Captured invocation has unresolved negative context')
  }
  return { ok: true, value: undefined }
}

/** Bind every owned invocation before interpreting any historical result. This is not eligibility. */
export function inventoryCapturedWork(
  evidence: WorkflowEvidence,
  replay?: AssessmentReplayContext,
): Result<readonly CapturedInvocation[]> {
  const histories = evidence.causal.histories
  const selected = [evidence.issue, ...(evidence.pullRequest === null ? [] : [evidence.pullRequest])]
  const causal = workflowCausalDiagnostics([...selected, ...evidence.parents], evidence.causal)
  if (causal.length) return { ok: false, diagnostics: causal }
  const identities = validateOperationIdentities(histories)
  if (!identities.ok) return identities
  const invocations: CapturedInvocation[] = []
  for (const history of selected) {
    const receipts = history.operations.flatMap((operation) =>
      operation.authority !== 'foreign' &&
      operation.record?.kind === 'action-receipt' &&
      inspected[operation.record.payload.action]
        ? [operation.record]
        : [],
    )
    const starts = validateStarts(receipts)
    if (!starts.ok) return starts
    for (const result of receipts.filter((record) => record.payload.phase === 'result')) {
      const invocation = authenticateInvocation(history, result, evidence, replay)
      if (!invocation.ok) return invocation
      invocations.push(invocation.value)
    }
    const terminal = validateTerminalContexts(history)
    if (!terminal.ok) return terminal
  }
  return { ok: true, value: invocations }
}
