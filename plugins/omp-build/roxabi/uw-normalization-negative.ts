import { missingContextOutputSchema } from '../dist/contracts.js'
import type { Diagnostic } from '../engine/record-values.ts'
import type { NativeBatchResult } from '../omp/review-runtime/contracts.ts'
import type { ContinueFeatureInput } from './feature-contract.ts'
import type { PreparedUwAction } from './uw-action-contract.ts'
import type { NormalizationProposalRequest } from './uw-contract.ts'
import { nativeResultDiagnostic, sealNormalizationResult } from './uw-normalization-settlement.ts'

export async function settleNormalizationNegative(input: {
  request: NormalizationProposalRequest
  original: ContinueFeatureInput
  prepared: PreparedUwAction
  operationId: string
  startId: string
  result: NativeBatchResult
  stopped: (reason: string, diagnostics?: readonly Diagnostic[], result?: NativeBatchResult | null) => Promise<void>
  stopForError: (error: unknown, result: NativeBatchResult | null) => Promise<void>
}): Promise<void> {
  const { result, request, stopped } = input
  if (result.canPublishContext?.() !== true) return
  const child = result.children[0]
  const parsed = missingContextOutputSchema.safeParse(child?.structured)
  if (!parsed.success || child?.contextBlock === undefined) {
    await stopped(
      'normalization-action-context-invalid',
      [nativeResultDiagnostic(result, 'Invalid context negative')],
      result,
    )
    return
  }
  try {
    const receipt = await sealNormalizationResult({ ...input, judgement: parsed.data })
    if (result.canPublishContext?.() !== true) return
    if (!receipt.ok) {
      await stopped(receipt.reason, [nativeResultDiagnostic(result, 'Context negative could not be retained')], result)
      return
    }
    await stopped(
      'action-context-missing',
      parsed.data.missing.map((item) => ({
        code: 'action-context-missing',
        message: item.reason,
        operationId: input.operationId,
        detail: {
          locator: item.locator,
          targets: item.targets,
          receipt: { scope: request.uw, recordId: receipt.recordId, kind: 'action-receipt', selector: '/payload' },
        },
      })),
      result,
    )
  } catch (error) {
    if (result.canPublishContext?.() === true) await input.stopForError(error, result)
  }
}
