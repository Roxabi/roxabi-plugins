import { randomUUID } from 'node:crypto'
import { hostInterruptionDiagnostic } from '../dist/contracts.js'
import type { ActionReceiptPayload } from '../engine/workflow-receipt-schema.ts'
import type { NativeBatchResult, NativeStop } from '../omp/review-runtime/contracts.ts'
import { type NonImplementPublication, resolvePublication } from './feature-action-publication-context.ts'
import { publishRecord } from './feature-engine.ts'

export async function publishInterruptedResult(
  context: NonImplementPublication,
  result: NativeBatchResult,
  stop: Extract<NativeStop, { kind: 'interrupted' }>,
): Promise<{ published: true; recordId: string } | { published: false; reason: string }> {
  const opened = context.opened
  if (!['plan', 'plan-review', 'assess-spec', 'attribute-ci'].includes(opened.payload.action))
    return { published: false, reason: 'action-interruption-unsupported' }
  const start = { scope: context.receiptScope, recordId: opened.recordId, kind: 'action-receipt' as const }
  const fresh = await resolvePublication({ cwd: context.cwd, result, start, gh: context.gh })
  if ('reason' in fresh) return { published: false, reason: fresh.reason }
  const recordId = randomUUID()
  const payload = {
    format: 'omp-build-action-receipt/2',
    phase: 'result',
    action: opened.payload.action,
    actionId: result.batch.operationId,
    mandate: opened.payload.mandate,
    start,
    inputs: opened.payload.inputs,
    exactInputs: opened.payload.exactInputs,
    ...(opened.payload.action === 'plan-review' ? { slots: opened.payload.slots, contributions: [] } : {}),
    native: { completion: 'incomplete', strict: 'absent', raw: result.children[0]?.raw ?? null },
    structured: null,
    admission: null,
    diagnostics: [hostInterruptionDiagnostic(stop.origin)],
  } as ActionReceiptPayload
  const published = await publishRecord(
    context.loaded,
    fresh.history,
    {
      repository: context.receiptScope.repository,
      target: context.receiptScope.target,
      version: 1,
      recordId,
      runId: randomUUID(),
      operationId: `${result.batch.operationId}:result`,
      kind: 'action-receipt',
      payload,
    },
    context.gh,
    context.cwd,
    fresh.publicationParents,
  )
  return published.ok ? { published: true, recordId } : { published: false, reason: published.reason }
}

/** Retain a settled failure without turning it into an interruptible receipt. */
export async function publishTerminalNegative(
  context: NonImplementPublication,
  result: NativeBatchResult,
  reason: string,
  strict: 'valid' | 'invalid' | 'absent',
): Promise<{ published: true; recordId: string } | { published: false; reason: string }> {
  const opened = context.opened
  const start = { scope: context.receiptScope, recordId: opened.recordId, kind: 'action-receipt' as const }
  const fresh = await resolvePublication({ cwd: context.cwd, result, start, gh: context.gh })
  if ('reason' in fresh) return { published: false, reason: fresh.reason }
  const child = result.children[0]
  const recordId = randomUUID()
  const payload = {
    format: 'omp-build-action-receipt/2',
    phase: 'result',
    action: opened.payload.action,
    actionId: opened.payload.actionId,
    mandate: opened.payload.mandate,
    start,
    inputs: opened.payload.inputs,
    exactInputs: opened.payload.exactInputs,
    ...(opened.payload.action === 'plan-review' ? { slots: opened.payload.slots, contributions: [] } : {}),
    native: {
      completion: child?.sdkTerminal === 'returned' || child?.usable === true ? 'completed' : 'incomplete',
      strict,
      raw: child?.raw ?? null,
    },
    structured: null,
    admission: null,
    diagnostics: [{ code: reason, message: reason }],
  } as ActionReceiptPayload
  const published = await publishRecord(
    context.loaded,
    fresh.history,
    {
      repository: context.receiptScope.repository,
      target: context.receiptScope.target,
      version: 1,
      recordId,
      runId: randomUUID(),
      operationId: `${result.batch.operationId}:result`,
      kind: 'action-receipt',
      payload,
    },
    context.gh,
    context.cwd,
    fresh.publicationParents,
  )
  return published.ok ? { published: true, recordId } : { published: false, reason: published.reason }
}
