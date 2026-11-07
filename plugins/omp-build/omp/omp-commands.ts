import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ompBuildStartReviewParametersJsonSchema, ompBuildStartReviewParametersSchema } from '../dist/contracts.js'
import { bindHostPluginPin } from './host-plugin-pin.ts'
import { hostUwFactory } from './host-uw-operations.ts'
import { INSTALL_ROOT } from './install-root'
import type { OmpBuildExtensionApi } from './omp-controller'
import { continueFramedFeature, runFeatureCommand } from './omp-feature-command.ts'
import type { FeatureCommandComposition, FeatureCommandOptions } from './omp-feature-command-host.ts'
import { installFeatureUwOperationLifecycle } from './omp-feature-composition.ts'
import { dispatchDefaultFix } from './omp-fix-dispatch'
import { type FramingRuntimeOptions, installFeatureFramingRuntime } from './omp-framing-runtime.ts'
import { dispatchDefaultReview } from './omp-review-dispatch'
import { registerOmpReviewRecoveryTools } from './omp-review-recovery-tools'
import { registerSkillCommand } from './omp-skill-command-runtime.ts'
import { SKILL_COMMANDS } from './omp-skill-commands.ts'
import { registerUwCommand } from './omp-uw-command.ts'
import { registerPrepareCheckoutTool } from './prepare-checkout-tool.ts'

export type OmpBuildExtensionOptions = FeatureCommandOptions & {
  exists?: (path: string) => boolean
  installRoot?: string
  framing?: FramingRuntimeOptions['framing']
}

export function registerOmpCommandsAndTools(
  pi: OmpBuildExtensionApi,
  options: OmpBuildExtensionOptions,
  interruptOwnedFeatureWork: (reason: string) => Promise<void>,
): void {
  bindHostPluginPin(options.pluginPin)
  const installRoot = options.installRoot ?? INSTALL_ROOT
  const skillsDir = join(installRoot, 'skills')
  const exists = options.exists ?? existsSync
  installFeatureUwOperationLifecycle(pi)
  // The controller calls `continueFeature` only after a later human attestation.
  const framing = installFeatureFramingRuntime(pi, options, (input) => continueFramedFeature(features, input))
  const features: FeatureCommandComposition = { pi, options, interruptOwnedFeatureWork, framing }
  pi.registerTool({
    name: 'omp_build_start_review',
    label: 'Start structured review',
    description: 'Prepare and dispatch the host-authorized native review for one existing pull request.',
    parameters: ompBuildStartReviewParametersJsonSchema,
    approval: 'write',
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const parsed = ompBuildStartReviewParametersSchema.safeParse(params)
      if (!parsed.success) throw new Error('invalid-omp-build-start-review-parameters')
      await dispatchDefaultReview(pi, ctx, parsed.data.pr === undefined ? '' : String(parsed.data.pr))
      return {
        content: [
          { type: 'text', text: 'Native review inventory was confirmed and the prepared batch was announced.' },
        ],
      }
    },
  })
  registerOmpReviewRecoveryTools(pi, options)
  registerPrepareCheckoutTool(pi)
  registerUwCommand(pi, options.uwOperations ?? hostUwFactory(options.pluginPin))

  for (const { name, skill = name, description, requires } of SKILL_COMMANDS) {
    if (name === 'feature') {
      pi.registerCommand(name, {
        description,
        handler: (args, ctx) => runFeatureCommand(args, ctx, features),
      })
      continue
    }
    if (name === 'dev-review') {
      pi.registerCommand(name, { description, handler: async (args, ctx) => dispatchDefaultReview(pi, ctx, args) })
      continue
    }
    if (name === 'fix') {
      pi.registerCommand(name, {
        description,
        handler: async (args, ctx) => {
          await dispatchDefaultFix(pi, ctx, args)
        },
      })
      continue
    }
    registerSkillCommand(pi, name, skill, description, requires, installRoot, skillsDir, exists)
  }
}
