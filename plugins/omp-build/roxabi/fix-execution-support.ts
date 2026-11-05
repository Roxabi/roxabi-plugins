import type { createNativeCorrectionExecution } from './correction-native-execution.ts'
import type { FixActionResult, FixIdentity, FixRecord, PreparedFix } from './fix-contract.ts'
import { failure } from './fix-contract.ts'
import { persistCauseDispositions } from './fix-disposition-execution.ts'
import type { DefaultFixWorkflow } from './fix-execution-policy.ts'

export async function pushAndReadHead(
  executor: ReturnType<typeof createNativeCorrectionExecution>,
  applied: boolean,
  signal: AbortSignal,
): Promise<FixActionResult<string>> {
  if (applied) {
    const pushed = await executor.push()
    if (!pushed.ok) return failure(...pushed.diagnostics)
    if (signal.aborted) return failure('fix-run-interrupted-cleanup-unproven')
  }
  const head = await executor.head()
  if (!head.ok) return failure(...head.diagnostics)
  if (signal.aborted) return failure('fix-run-interrupted-cleanup-unproven')
  return { ok: true, value: head.value }
}

export async function retainFailedOutput(
  prepared: PreparedFix,
  records: FixRecord[],
  diagnostics: string[],
  product: DefaultFixWorkflow,
  identity: FixIdentity,
  refusal: string[],
): Promise<FixActionResult<never>> {
  const retained = await persistCauseDispositions(
    prepared,
    {
      kind: 'retained-output',
      contributions: records.filter(
        (item): item is Extract<FixRecord, { kind: 'contribution' }> => item.kind === 'contribution',
      ),
      diagnostics: diagnostics.map((code) => ({ code, message: code })),
    },
    identity,
    product.dispositionStore,
  )
  return retained.ok ? failure(...refusal) : retained
}
