import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import {
  ompBuildRecoveryPrParametersJsonSchema,
  ompBuildRecoveryPrParametersSchema,
  ompBuildRecoveryReplaceParametersJsonSchema,
  ompBuildRecoveryReplaceParametersSchema,
} from '../dist/contracts.js'
import { prepareReviewInputs } from '../roxabi/review-pr-inputs.ts'
import {
  ghGrantInterruptedReviewReplacement,
  ghReplaceInterruptedReview,
  ghTerminalizeInterruptedReview,
} from '../roxabi/review-recovery-gh.ts'
import { hostPluginPin } from './host-plugin-pin.ts'
import { createHostUwOperations } from './host-uw-operations.ts'
import type { OmpBuildExtensionApi } from './omp-controller'
import { createOperatorConfirmation } from './omp-operator-confirmation.ts'
import { dispatchPreparedReplacementReview } from './omp-review-dispatch'

export type OmpReviewRecoveryToolOptions = {
  prepareReview?: typeof prepareReviewInputs
}

function contextWindow(ctx: ExtensionContext): number {
  const value = ctx.model?.contextWindow
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    throw new Error('current model has no usable context window')
  return value
}

function publicationError(result: { diagnostics: readonly { code: string; message: string }[] }): Error {
  return new Error(result.diagnostics.map((item) => `${item.code}:${item.message}`).join(','))
}

/** Register native recovery operations; terminal/grant are disarmed, replace activates only confirmed R2. */
export function registerOmpReviewRecoveryTools(pi: OmpBuildExtensionApi, options: OmpReviewRecoveryToolOptions): void {
  pi.registerTool({
    name: 'omp_build_terminalize_interrupted_review',
    label: 'Terminalize interrupted review',
    description:
      'Publish a neutral review-interruption for one unfinished initial pull-request inventory after historical B1/M1/I4 proof. Keeps the PR disarmed.',
    parameters: ompBuildRecoveryPrParametersJsonSchema,
    approval: 'write',
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const parsed = ompBuildRecoveryPrParametersSchema.safeParse(params)
      if (!parsed.success) throw new Error('invalid-omp-build-terminalize-interrupted-review-parameters')
      const published = await ghTerminalizeInterruptedReview({ cwd: ctx.cwd, pr: parsed.data.pr })
      if (!published.ok) throw publicationError(published)
      return {
        content: [
          { type: 'text', text: `Published review-interruption ${published.value.recordId}; PR stays disarmed.` },
        ],
      }
    },
  })
  pi.registerTool({
    name: 'omp_build_grant_review_replacement',
    label: 'Grant review replacement',
    description:
      'Prepare fresh review evidence and publish one one-use review-replacement-grant after a confirmed interruption. Starts no review tasks.',
    parameters: ompBuildRecoveryPrParametersJsonSchema,
    approval: 'write',
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const parsed = ompBuildRecoveryPrParametersSchema.safeParse(params)
      if (!parsed.success) throw new Error('invalid-omp-build-grant-review-replacement-parameters')
      const operations = await createHostUwOperations(ctx, createOperatorConfirmation(ctx))
      const published = await ghGrantInterruptedReviewReplacement({
        cwd: ctx.cwd,
        pr: parsed.data.pr,
        contextWindow: contextWindow(ctx),
        operations,
        prepareReview: async (request) =>
          (options.prepareReview ?? prepareReviewInputs)({
            ...request,
            operations,
            pluginPin: hostPluginPin(),
          }),
      })
      if (!published.ok) throw publicationError(published)
      return {
        content: [{ type: 'text', text: `Published one-use review-replacement-grant ${published.value.recordId}.` }],
      }
    },
  })
  pi.registerTool({
    name: 'omp_build_replace_interrupted_review',
    label: 'Replace interrupted review',
    description:
      'Confirm and activate the linked replacement inventory for the unconsumed one-use review replacement grant.',
    parameters: ompBuildRecoveryReplaceParametersJsonSchema,
    approval: 'write',
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const parsed = ompBuildRecoveryReplaceParametersSchema.safeParse(params)
      if (!parsed.success) throw new Error('invalid-omp-build-replace-interrupted-review-parameters')
      const operations = await createHostUwOperations(ctx, createOperatorConfirmation(ctx))
      const published = await ghReplaceInterruptedReview({
        cwd: ctx.cwd,
        pr: parsed.data.pr,
        contextWindow: contextWindow(ctx),
        operations,
        prepareReview: async (request) =>
          (options.prepareReview ?? prepareReviewInputs)({
            ...request,
            operations,
            pluginPin: hostPluginPin(),
          }),
      })
      if (!published.ok) throw publicationError(published)
      await dispatchPreparedReplacementReview(
        pi,
        ctx,
        published.value.input,
        published.value.inventory,
        published.value.grantId,
      )
      return {
        content: [
          {
            type: 'text',
            text: `Confirmed replacement inventory ${published.value.recordId} and announced its native review batch.`,
          },
        ],
      }
    },
  })
}
