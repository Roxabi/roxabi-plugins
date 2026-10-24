import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import type { PreparedEpicReview } from '../roxabi/epic-range-finalization.ts'
import type { ReviewPublisher } from '../roxabi/review-contract.ts'
import { ReviewProduct } from '../roxabi/review-dispatch.ts'
import { createPreparedReviewRunner } from '../roxabi/review-entry'
import { prepareReviewInputs } from '../roxabi/review-pr-inputs.ts'
import { validateReviewInput } from '../skills/feature/workflow-review-input.js'
import { nextReviewStep } from '../skills/feature/workflow-review-state.js'
import { createOmpReviewProduct, hasOwnedFixRun, reviewControllerFor } from './omp-controller'
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
    completeStage: async (prepared, result, contributions) => {
      const next = await review.publisher.completeStage(prepared, result, contributions)
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
  scopedGuard?: () => boolean
}

async function dispatchDefaultReview(
  pi: NativeExtension,
  ctx: ExtensionContext,
  args: string,
  options: DefaultReviewOptions = {},
): Promise<void> {
  const { onComplete, prepareReview = prepareReviewInputs, scopedGuard } = options
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
  })
  if (!prepared.ok)
    throw new Error(`review-input-preparation-refused:${prepared.diagnostics.map((item) => item.code).join(',')}`)
  const input = prepared.value
  const admission = await nextReviewStep(ctx.cwd, input.pr.number, { reviewing: true })
  if (admission.action !== 'review') throw new Error(`review-not-authorized:${admission.action}`)
  const authorize = async (
    stage: 'initial' | 'recall' | 'synthesis',
  ): Promise<{ ok: true } | { ok: false; reason: string }> => {
    const validation = await validateReviewInput(ctx.cwd, input.pr.number, input.pr.head, input.capture.input)
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
          completeStage: async (prepared, result, contributions) => {
            const next = await runner.completeStage(prepared, result, contributions)
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

export { dispatchDefaultReview, prepareInstalledEpicRangeReview }
