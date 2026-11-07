import { createRequire } from 'node:module'
import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import type {
  FeatureCommandHost,
  FeatureFixTerminal,
  FeatureReviewFix,
  FeatureWorkflow,
} from '../roxabi/feature-contract.ts'
import { loadFeatureWorkflow } from '../roxabi/feature-loader.ts'
import type { FixStart } from '../roxabi/fix-entry-lifecycle.ts'
import type { prepareReviewInputs } from '../roxabi/review-pr-inputs.ts'
import type { TrustedHostPluginPin } from '../roxabi/uw-action-contract.ts'
import { type OmpBuildExtensionApi, ownedFixRunFor, reportFeatureTerminalStatus } from './omp-controller'
import { dispatchAdmittedCiCorrection, dispatchDefaultFix } from './omp-fix-dispatch'
import type { FeatureFramingRuntime, FramingCommandBinding } from './omp-framing-runtime.ts'
import { requestParentCoverage } from './omp-parent-coverage.ts'
import { dispatchDefaultReview, prepareInstalledEpicRangeReview } from './omp-review-dispatch'
import type { UwOperationsFactory } from './omp-uw-command.ts'
import type { NativeBatchController } from './review-runtime/controller.ts'
import { createNativeReviewPort } from './review-runtime/port.ts'

export type FeatureCommandOptions = {
  /** Override seam for tests; installed commands default to the concrete UW backend. */
  uwOperations?: UwOperationsFactory
  /** Trusted host composition only. Not argv, env, or tool JSON. */
  pluginPin?: TrustedHostPluginPin
  featureWorkflow?: FeatureWorkflow
  principalCwd?: (cwd: string) => boolean
  prepareReview?: typeof prepareReviewInputs
  startFeatureFix?: (input: FeatureReviewFix) => Promise<{ terminal: Promise<FeatureFixTerminal> }>
}

export type FeatureCommandComposition = Readonly<{
  pi: OmpBuildExtensionApi
  options: FeatureCommandOptions
  interruptOwnedFeatureWork: (reason: string) => Promise<void>
  framing: FeatureFramingRuntime
}>

const requireFromIndex = createRequire(import.meta.url)

function hasPrincipalCwd(value: unknown): value is { isPrincipalCwd?: (cwd: string) => boolean } {
  return typeof value === 'object' && value !== null && 'isPrincipalCwd' in value
}

function isInstalledPrincipal(cwd: string): boolean {
  try {
    const freeze = requireFromIndex('../hooks/lib/principal-freeze.cjs')
    return hasPrincipalCwd(freeze) && freeze.isPrincipalCwd?.(cwd) === true
  } catch {
    return false
  }
}

function unownedFeatureFixTerminal(started: FixStart): FeatureFixTerminal {
  if (started.status === 'accepted') return { status: 'stopped', diagnostics: ['fix-run-unavailable'] }
  return started.result.ok
    ? { status: 'complete', recordId: started.result.value.recordId, kind: 'fix-result' }
    : { status: 'stopped', diagnostics: started.result.diagnostics }
}

async function startInstalledFeatureFix(
  pi: OmpBuildExtensionApi,
  ctx: ExtensionContext,
  input: FeatureReviewFix,
): Promise<{ terminal: Promise<FeatureFixTerminal> }> {
  const started = await dispatchDefaultFix(pi, ctx, '', input)
  const owned = ownedFixRunFor(pi)
  return owned === undefined
    ? { terminal: Promise.resolve(unownedFeatureFixTerminal(started)) }
    : { terminal: owned.run.terminal }
}

export async function loadInstalledFeatureWorkflow(
  pi: OmpBuildExtensionApi,
  options: FeatureCommandOptions,
): Promise<FeatureWorkflow | undefined> {
  try {
    return options.featureWorkflow ?? (await loadFeatureWorkflow())
  } catch (error) {
    reportFeatureTerminalStatus(pi, `feature-stopped: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

export function createFeatureCommandHost(
  composition: FeatureCommandComposition,
  binding: FramingCommandBinding,
  workflow: FeatureWorkflow,
  controller: NativeBatchController,
  uw: FeatureCommandHost['uw'],
): FeatureCommandHost {
  const { pi, options, interruptOwnedFeatureWork, framing } = composition
  const { ctx } = binding
  return {
    key: pi,
    cwd: ctx.cwd,
    principal: options.principalCwd?.(ctx.cwd) ?? isInstalledPrincipal(ctx.cwd),
    workflow,
    native: createNativeReviewPort(pi, controller),
    send: async (message) => reportFeatureTerminalStatus(pi, message),
    status: (message) => ctx.ui?.setStatus?.('omp-build-watch', message),
    startFraming: (source) => framing.start(binding, source),
    requestParentCoverage: (request) => requestParentCoverage(ctx, request),
    inhibitFeatureContinuation: () => controller.inhibitFeatureContinuation(),
    releaseFeatureContinuation: () => controller.releaseFeatureContinuation(),
    featureContinuationInhibited: () => controller.featureContinuationInhibited(),
    markFeatureBatch: (batch) => controller.markFeatureBatch(batch),
    ...(uw === undefined ? {} : { uw }),
    ...(options.pluginPin === undefined ? {} : { pluginPin: options.pluginPin }),
    interruptOwnedWork: interruptOwnedFeatureWork,
    startReview: (args, onComplete) =>
      dispatchDefaultReview(pi, ctx, args, {
        onComplete,
        prepareReview: options.prepareReview,
        scopedGuard: () => !controller.featureContinuationInhibited(),
      }),
    prepareEpicRangeReview: (review, onComplete) => prepareInstalledEpicRangeReview(pi, review, onComplete),
    exec: (command, args, executionOptions) => pi.exec(command, args, executionOptions),
    startFix: options.startFeatureFix ?? ((input) => startInstalledFeatureFix(pi, ctx, input)),
    startAdmittedCiCorrection: async (input) => {
      const run = await dispatchAdmittedCiCorrection(pi, ctx, input)
      return { terminal: run.terminal }
    },
  }
}
