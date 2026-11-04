import type { NativeBatch } from '../omp/review-runtime/contracts.ts'
import type { CorrectionEffectResult } from './correction-execution-contract.ts'
import type { FixActionResult, FixRecord } from './fix-contract.ts'
import { failure } from './fix-contract.ts'
import { admitDecisionExecution, type DefaultFixWorkflow } from './fix-execution-policy.ts'
export async function authorizeCorrectionContinuation(runtime: DefaultFixWorkflow['runtime']) {
  const allowed =
    runtime.beforeContinuation === undefined
      ? { ok: true as const, value: undefined }
      : await runtime.beforeContinuation()
  return allowed.ok ? { ok: true as const, value: undefined } : allowed
}

export async function correctionStarted(
  runtime: DefaultFixWorkflow['runtime'],
  batch: NativeBatch,
): Promise<CorrectionEffectResult<void>> {
  if (runtime.signal.aborted) return { ok: false, kind: 'terminal', diagnostics: ['fix-run-aborted'] }
  runtime.onStarted(batch)
  return { ok: true, value: undefined }
}

export async function admitStoredDecision(
  decision: Extract<FixRecord, { kind: 'decision' }>,
  product: Pick<DefaultFixWorkflow, 'readHistory'>,
  incompleteDiagnostic: string,
  unreadableDiagnostic: string,
): Promise<FixActionResult<void>> {
  try {
    const history = await product.readHistory()
    if (!history.source.complete) return failure(incompleteDiagnostic)
    return admitDecisionExecution(decision, history)
  } catch (error) {
    return failure(`${unreadableDiagnostic}:${error instanceof Error ? error.message : String(error)}`)
  }
}
