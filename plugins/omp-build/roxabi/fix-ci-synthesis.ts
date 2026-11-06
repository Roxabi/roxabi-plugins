import type { PreparedCauseCapture } from '../dist/contracts.js'
import type { FixActionResult, FixIdentity, FixRecord, PreparedFix, PublishBinding } from './fix-contract.ts'
import { failure } from './fix-contract.ts'
import { type FixIntakePublication, publishNativeContributions } from './fix-contributions-native.ts'
import {
  finalizeCorrectionSynthesis,
  type PreservedSynthesis,
  prepareCorrectionSynthesis,
} from './fix-contributions-synthesis.ts'
import { persistCapturedCauseDispositions } from './fix-disposition-capture.ts'
import type { DefaultFixWorkflow } from './fix-execution-policy.ts'
import { actionTask, dispatchNativeBatch } from './fix-native-dispatch.ts'
import { nativeFixProfileByAction } from './native-review-profiles'

export type CiCorrectionProduct = DefaultFixWorkflow & { identity: FixIdentity; publishBinding: PublishBinding }
export async function synthesizeCiCorrection(
  prepared: PreparedFix,
  product: CiCorrectionProduct,
  evidence: FixRecord,
  intake: FixIntakePublication,
): Promise<FixActionResult<{ decision: FixRecord; capture: PreparedCauseCapture }>> {
  const synthesisTask = actionTask(
    'ci-correction-synthesis',
    nativeFixProfileByAction.synthesis,
    'Synthesize one correction-purpose decision only from the confirmed CI attribution and intake records named by the index. Do not replay review findings. Do not edit, commit, push, arm, or land.',
    'one correction decision from attributed CI evidence',
  )
  const synthesis = await prepareCorrectionSynthesis(
    prepared,
    product.identity,
    product.publisher,
    [evidence, ...intake.records],
    synthesisTask,
    product.runtime.uw,
  )
  if (!synthesis.ok) return synthesis
  const preservedSynthesis = await dispatchNativeBatch<PreservedSynthesis>(
    product.native,
    synthesis.value.batch,
    product.runtime,
    async (result) => {
      const contributions = await publishNativeContributions(
        prepared,
        product.identity,
        product.publisher,
        synthesis.value.inventoryId,
        [synthesisTask],
        'synthesis',
        'decision',
        [synthesis.value.inventoryId, ...synthesis.value.sourceContributionIds],
        result,
      )
      return contributions.ok ? { ok: true, value: { result, contributions: contributions.value } } : contributions
    },
    false,
  )
  if (!preservedSynthesis.ok) return preservedSynthesis
  if (product.runtime.signal.aborted) return failure('fix-run-interrupted-cleanup-unproven')
  const decision = await finalizeCorrectionSynthesis(
    prepared,
    synthesis.value,
    product.identity,
    product.publisher,
    preservedSynthesis.value,
    product.runtime.signal,
  )
  if (decision.ok) return { ok: true, value: { decision: decision.value, capture: synthesis.value.capture } }
  const retained = await persistCapturedCauseDispositions(
    prepared.causeContext,
    {
      kind: 'retained-output',
      contributions: [evidence, ...intake.records, ...preservedSynthesis.value.contributions].filter(
        (item): item is Extract<FixRecord, { kind: 'contribution' }> => item.kind === 'contribution',
      ),
      diagnostics: decision.diagnostics.map((code) => ({ code, message: code })),
    },
    product.identity,
    product.dispositionStore,
    product.runtime.uw,
    synthesis.value.capture,
  )
  return retained.ok ? decision : retained
}
