import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import type { CanonicalRecord } from '../dist/contracts.js'
import type { PreparedEpicReview } from '../roxabi/epic-range-finalization.ts'
import type { ReviewPublisher } from '../roxabi/review-contract.ts'
import { ReviewProduct } from '../roxabi/review-dispatch.ts'
import { createPreparedReviewRunner } from '../roxabi/review-entry'
import type { PreparedReviewInputs, PrepareReviewInputsOptions } from '../roxabi/review-input-contract.ts'
import { prepareReviewInputs } from '../roxabi/review-pr-inputs.ts'
import { validatePreparedReviewInput, validateReviewInput } from '../skills/feature/workflow-review-input.js'
import { nextReviewStep } from '../skills/feature/workflow-review-state.js'
import { hostPluginPin } from './host-plugin-pin.ts'
import { createHostUwOperations } from './host-uw-operations.ts'
import { createOmpReviewProduct, hasOwnedFixRun, reviewControllerFor } from './omp-controller'
import { createOperatorConfirmation } from './omp-operator-confirmation.ts'
import type { NativeExtension } from './review-runtime/contracts.ts'
import { createNativeReviewPort } from './review-runtime/port.ts'

async function prepareInstalledEpicRangeReview(
  pi: NativeExtension,
  review: PreparedEpicReview,
  onComplete: () => Promise<void>,
): Promise<void> {
  let completionInvoked = false
  const publisher: ReviewPublisher = {
    authorize: (context, stage) => review.publisher.authorize(context, stage),
    publishInventory: (prepared) => review.publisher.publishInventory(prepared),
    publishRawContribution: (prepared, child) => review.publisher.publishRawContribution(prepared, child),
    completeStage: async (prepared, result, contributions, canContinue) => {
      if (canContinue === undefined) throw new Error('review-continuation-unfenced')
      const next = await review.publisher.completeStage(prepared, result, contributions, canContinue)
      if (!canContinue()) return null
      if (next === null && !completionInvoked) {
        completionInvoked = true
        await onComplete()
      }
      return next
    },
    publishRequiredStop: (context, stop, options) => review.publisher.publishRequiredStop(context, stop, options),
    stop: (context, reason, result) => review.publisher.stop(context, reason, result),
  }
  await createOmpReviewProduct(pi, publisher).prepareEpicRangeReview(review.context, review.prepared)
}

type DefaultReviewOptions = {
  onComplete?: () => Promise<void>
  prepareReview?: typeof prepareReviewInputs
  expansion?: PrepareReviewInputsOptions['expansion']
  scopedGuard?: () => boolean
}

type ReplacementDispatchOptions = {
  validateReview?: typeof validateReviewInput
}

/**
 * Activate the already read-back replacement inventory without consulting the
 * ordinary root allocator. The runner rebuilds and checks its native slots
 * against that exact inventory before the product is allowed to announce it.
 */
async function dispatchPreparedReplacementReview(
  pi: NativeExtension,
  ctx: Pick<ExtensionContext, 'cwd'>,
  input: PreparedReviewInputs,
  inventory: Extract<CanonicalRecord, { kind: 'review-attempt' }>,
  grantId: string,
  options: ReplacementDispatchOptions = {},
): Promise<void> {
  if (hasOwnedFixRun(pi)) throw new Error('fix-run-already-active')
  const authorize = async (
    stage: 'initial' | 'recall' | 'synthesis',
  ): Promise<{ ok: true } | { ok: false; reason: string }> => {
    const validation = await (options.validateReview ?? validateReviewInput)(
      ctx.cwd,
      input.pr.number,
      input.pr.head,
      input.capture.input,
      { pluginPin: hostPluginPin() },
    )
    if (!validation.ok) return { ok: false, reason: `${stage}:${validation.reason}` }
    return { ok: true }
  }
  const runner = createPreparedReviewRunner(
    input,
    { cwd: ctx.cwd, readAuthor: input.automationLogin, writeAuthor: input.automationLogin },
    authorize,
    {
      identity: {
        runId: `review-replacement-${grantId}`,
        operationId: `review-replacement-operation-${grantId}`,
      },
      initialInventory: inventory,
    },
  )
  await createOmpReviewProduct(pi, runner).preparePullRequestReview(runner.context, runner.initialBatch())
}

async function dispatchDefaultReview(
  pi: NativeExtension,
  ctx: ExtensionContext,
  args: string,
  options: DefaultReviewOptions = {},
): Promise<void> {
  const { onComplete, prepareReview = prepareReviewInputs, scopedGuard, expansion } = options
  if (hasOwnedFixRun(pi)) throw new Error('fix-run-already-active')
  const supplied = args.trim()
  if (supplied !== '' && !/^[1-9]\d*$/.test(supplied))
    throw new Error('/dev-review accepts one positive pull-request number')
  const contextWindow = ctx.model?.contextWindow
  if (typeof contextWindow !== 'number' || !Number.isSafeInteger(contextWindow) || contextWindow <= 0)
    throw new Error('current model has no usable context window')
  const prepared = await prepareReview({
    cwd: ctx.cwd,
    pr: supplied === '' ? undefined : Number(supplied),
    contextWindow,
    operations: await createHostUwOperations(ctx, createOperatorConfirmation(ctx)),
    pluginPin: hostPluginPin(),
    expansion,
  })
  if (!prepared.ok)
    throw new Error(`review-input-preparation-refused:${prepared.diagnostics.map((item) => item.code).join(',')}`)
  const input = prepared.value
  const admission = await nextReviewStep(ctx.cwd, input.pr.number, { reviewing: true })
  if (admission.action !== 'review') throw new Error(`review-not-authorized:${admission.action}`)
  const authorize = async (
    stage: 'initial' | 'recall' | 'synthesis',
  ): Promise<{ ok: true } | { ok: false; reason: string }> => {
    if (
      input.context.input !== input.inputSnapshot.fingerprint ||
      (expansion === undefined && input.inputSnapshot.fingerprint !== input.capture.input)
    )
      return { ok: false, reason: `${stage}:review-input-changed` }
    const validation =
      stage === 'initial'
        ? await validatePreparedReviewInput(ctx.cwd, input.pr.number, input.pr.head, input.inputSnapshot, {
            pluginPin: hostPluginPin(),
          })
        : await validateReviewInput(ctx.cwd, input.pr.number, input.pr.head, input.inputSnapshot.fingerprint, {
            pluginPin: hostPluginPin(),
          })
    if (!validation.ok) return { ok: false, reason: `${stage}:${validation.reason}` }
    return { ok: true }
  }
  const runner = createPreparedReviewRunner(
    input,
    { cwd: ctx.cwd, readAuthor: input.automationLogin, writeAuthor: input.automationLogin },
    authorize,
  )
  let completionInvoked = false
  const publisher: ReviewPublisher =
    onComplete === undefined
      ? runner
      : {
          authorize: (context, stage) => runner.authorize(context, stage),
          publishInventory: (prepared) => runner.publishInventory(prepared),
          publishRawContribution: (prepared, child) => runner.publishRawContribution(prepared, child),
          completeStage: async (prepared, result, contributions, canContinue) => {
            if (canContinue === undefined) throw new Error('review-continuation-unfenced')
            const next = await runner.completeStage(prepared, result, contributions, canContinue)
            if (!canContinue()) return null
            if (next === null && !completionInvoked) {
              completionInvoked = true
              await onComplete()
            }
            return next
          },
          publishRequiredStop: () => runner.publishRequiredStop(),
          stop: (context, reason) => runner.stop(context, reason),
        }
  if (hasOwnedFixRun(pi)) throw new Error('fix-run-already-active')
  const product = new ReviewProduct(createNativeReviewPort(pi, reviewControllerFor(pi)), publisher, {
    canDispatch: () => !hasOwnedFixRun(pi) && (scopedGuard?.() ?? true),
    refusalReason: () => ((scopedGuard?.() ?? true) ? 'fix-run-active' : 'continuation-inhibited'),
  })
  await product.preparePullRequestReview(runner.context, runner.initialBatch())
}

export { dispatchDefaultReview, dispatchPreparedReplacementReview, prepareInstalledEpicRangeReview }
