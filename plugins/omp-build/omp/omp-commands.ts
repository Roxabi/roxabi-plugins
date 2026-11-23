import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { bindHostPluginPin } from './host-plugin-pin.ts'
import { hostUwFactory } from './host-uw-operations.ts'
import { INSTALL_ROOT } from './install-root'
import type { OmpBuildExtensionApi } from './omp-controller'
import {
  continueFramedFeature,
  type FeatureCommandComposition,
  type FeatureCommandOptions,
  runFeatureCommand,
} from './omp-feature-command.ts'
import { installFeatureUwOperationLifecycle } from './omp-feature-composition.ts'
import { type FramingRuntimeOptions, installFeatureFramingRuntime } from './omp-framing-runtime.ts'
import { registerSkillCommand } from './omp-skill-command-runtime.ts'
import { SKILL_COMMANDS } from './omp-skill-commands.ts'
import { registerUwCommand } from './omp-uw-command.ts'
import { registerPrepareCheckoutTool } from './prepare-checkout-tool.ts'
import { registerToolingPinCommand } from './tooling-pin-command.ts'

export type OmpBuildExtensionOptions = FeatureCommandOptions & {
  exists?: (path: string) => boolean
  installRoot?: string
  framing?: FramingRuntimeOptions['framing']
}

export function registerOmpCommandsAndTools(
  pi: OmpBuildExtensionApi,
  options: OmpBuildExtensionOptions,
  interruptOwnedFeatureWork: FeatureCommandComposition['interruptOwnedFeatureWork'],
): void {
  bindHostPluginPin(pi, options.pluginPin)
  const installRoot = options.installRoot ?? INSTALL_ROOT
  const skillsDir = join(installRoot, 'skills')
  const exists = options.exists ?? existsSync
  installFeatureUwOperationLifecycle(pi)
  // The controller calls `continueFeature` only after a later human attestation.
  const framing = installFeatureFramingRuntime(pi, options, (input) => continueFramedFeature(features, input))
  const features = { pi, options, interruptOwnedFeatureWork, framing, installRoot, skillsDir, exists }
  registerPrepareCheckoutTool(pi)
  registerUwCommand(pi, options.uwOperations ?? hostUwFactory())
  registerToolingPinCommand(pi)

  for (const { name, skill = name, description, requires } of SKILL_COMMANDS) {
    if (name === 'feature') {
      pi.registerCommand(name, {
        description,
        handler: (args, ctx) => runFeatureCommand(args, ctx, features),
      })
      continue
    }
    registerSkillCommand(pi, name, skill, description, requires, installRoot, skillsDir, exists)
  }
}
