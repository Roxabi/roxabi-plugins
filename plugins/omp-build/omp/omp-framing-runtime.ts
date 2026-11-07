import { fileURLToPath } from 'node:url'
import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { ompBuildFramingSubmitParametersJsonSchema } from '../dist/contracts.js'
import { defaultGh } from '../roxabi/feature-engine.ts'
import {
  type FeatureFramingControllerHost,
  FRAMING_SUBMIT_TOOL,
  type FramingController,
  type FramingSourceRequest,
} from '../roxabi/feature-framing-contract.ts'
import { createFeatureFramingController } from '../roxabi/feature-framing-controller.ts'
import type { TrustedHostPluginPin } from '../roxabi/uw-action-contract.ts'
import { createProductionInputPorts } from '../roxabi/uw-input-readers.ts'
import { defaultGit } from '../roxabi/workflow-checkout.ts'
import { hostPluginPin } from './host-plugin-pin.ts'
import { resolveFeatureUw } from './host-uw-operations.ts'
import type { OmpBuildExtensionApi } from './omp-controller.ts'
import {
  claimFeatureFramingOwner,
  currentFeatureFraming,
  featureOperationInstanceId,
  featureUwOperationOrigin,
} from './omp-feature-composition.ts'
import { rootContext } from './omp-feature-session.ts'
import { type CommandOperatorPort, createOperatorConfirmation } from './omp-operator-confirmation.ts'
import type { UwOperationsFactory } from './omp-uw-command.ts'

/** Registered provenance of the one framing submit tool; the read-only admission gate requires it. */
export const FRAMING_SUBMIT_SOURCE_PATH = fileURLToPath(import.meta.url)
/** The sole genuine human surface for confirming a proposal or attesting a completed `/move`. */
export const FRAMING_SHORTCUT = 'ctrl+alt+u'
const FRAMING_STATUS = 'omp-build-framing'

export type FramingRuntimeOptions = {
  uwOperations?: UwOperationsFactory
  pluginPin?: TrustedHostPluginPin
  /** Trusted host composition and tests only; defaults are the installed GitHub, git and pin readers. */
  framing?: Partial<Pick<FeatureFramingControllerHost, 'gh' | 'git' | 'procedurePorts'>>
}

/**
 * The command operation that classified the source. `originalArgs` is the exact SDK command text for a
 * `/feature` entry; a post-framing continuation has none and keeps the classified source.
 */
export type FramingCommandBinding = Readonly<{
  ctx: ExtensionContext
  operator: CommandOperatorPort
  originalArgs: string | null
}>

export type FeatureFramingRuntime = Readonly<{
  /** Root's `FeatureCommandHost.startFraming` for one bound command operation. */
  start(binding: FramingCommandBinding, source: FramingSourceRequest): Promise<void>
}>

/** The bound operation must still own the slot, from the same root session and agent it captured. */
function currentBinding(pi: OmpBuildExtensionApi, binding: FramingCommandBinding): boolean {
  const { ctx, operator } = binding
  if (!rootContext(ctx)) return false
  const origin = featureUwOperationOrigin(pi, operator)
  return origin !== null && origin.agentId === ctx.agent.id && origin.sessionId === ctx.sessionManager.getSessionId()
}

/**
 * One framing controller per extension instance, bound to the one owner slot. Registers the read-only
 * submit tool, the context projection and the human shortcut; returns Root's `startFraming` port.
 */
export function installFeatureFramingRuntime(
  pi: OmpBuildExtensionApi,
  options: FramingRuntimeOptions,
  continueFeature: FeatureFramingControllerHost['continueFeature'],
): FeatureFramingRuntime {
  let statusContext: ExtensionContext | null = null
  const gh = options.framing?.gh ?? defaultGh()
  const git = options.framing?.git ?? defaultGit()
  const procedurePorts: FeatureFramingControllerHost['procedurePorts'] =
    options.framing?.procedurePorts ??
    (({ cwd }) => {
      const pin = options.pluginPin ?? hostPluginPin()
      return createProductionInputPorts({ cwd, gh, git, ...(pin === undefined ? {} : { pluginPin: pin }) })
    })
  const controller: FramingController = createFeatureFramingController({
    owner: {
      extensionInstanceId: featureOperationInstanceId(pi),
      claim: (revoke) => claimFeatureFramingOwner(pi, controller, revoke),
    },
    sendUserMessage: (content, sendOptions) => pi.sendUserMessage(content, sendOptions),
    status: (message) => statusContext?.ui?.setStatus?.(FRAMING_STATUS, message),
    procedurePorts,
    operator: (ctx) => createOperatorConfirmation(ctx),
    uw: ({ ctx, operator }) => resolveFeatureUw(ctx, operator, options.uwOperations, options.pluginPin),
    gh,
    git,
    ...(options.pluginPin === undefined ? {} : { pluginPin: options.pluginPin }),
    continueFeature,
  })
  const governed = (ctx: ExtensionContext): boolean =>
    rootContext(ctx) && currentFeatureFraming(pi) === controller && controller.governs(ctx)

  pi.registerTool({
    name: FRAMING_SUBMIT_TOOL,
    label: 'Submit framing form',
    description:
      'Submit one read-only form for the active omp-build framing interview, with the supply token from the latest framing procedure. It never writes, confirms, moves or delivers; only the operator confirms a staged proposal.',
    parameters: ompBuildFramingSubmitParametersJsonSchema,
    approval: 'read',
    // Top-level: the read-only gate denies `write`, so an `xd://` device mount would be unreachable.
    loadMode: 'essential',
    sourcePath: FRAMING_SUBMIT_SOURCE_PATH,
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      if (signal === undefined || !governed(ctx))
        throw new Error('framing-submit-unavailable: no framing interview is governed by this root session')
      const result = await controller.submit(params, { ctx, toolCallId, signal })
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    },
  })

  pi.on('context', async (event, ctx) => {
    if (!governed(ctx)) return undefined
    return controller.project(event, ctx)
  })

  pi.registerShortcut(FRAMING_SHORTCUT, {
    description: 'omp-build framing: review and confirm the staged proposal, or continue after the native /move',
    handler: async (ctx) => {
      if (!rootContext(ctx)) return
      statusContext = ctx
      await controller.act(ctx)
    },
  })

  return Object.freeze({
    async start(binding: FramingCommandBinding, source: FramingSourceRequest) {
      // A stale or late callback from a replaced command never begins framing.
      if (!currentBinding(pi, binding)) return
      const accepted: FramingSourceRequest =
        source.kind === 'free-text' && binding.originalArgs !== null
          ? { kind: 'free-text', acceptedArgs: binding.originalArgs }
          : source
      statusContext = binding.ctx
      const lease = controller.begin(accepted, binding.ctx)
      await controller.start(lease)
    },
  })
}
