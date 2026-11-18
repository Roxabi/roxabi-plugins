import { createRequire } from 'node:module'
import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import type {
  FeatureCommandHost,
  FeatureFixTerminal,
  FeatureReviewFix,
  FeatureWorkflow,
} from '../roxabi/feature-contract.ts'
import { type FeatureCurrent, ownedFeatureFor } from '../roxabi/feature-host-ownership.ts'
import { loadFeatureWorkflow } from '../roxabi/feature-loader.ts'
import type { FixStart } from '../roxabi/fix-entry-lifecycle.ts'
import type { prepareReviewInputs } from '../roxabi/review-pr-inputs.ts'
import type { TrustedHostPluginPin } from '../roxabi/uw-action-contract.ts'
import { ownedContextEffectObserverFactory } from './omp-context-effect-observer.ts'
import { type OmpBuildExtensionApi, ownedFixRunFor, reportFeatureTerminalStatus } from './omp-controller'
import { type FeatureOperationReportGuard, featureOperationGeneration } from './omp-feature-composition.ts'
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
  interruptOwnedFeatureWork: NonNullable<FeatureCommandHost['interruptOwnedWork']>
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
  pluginPin: TrustedHostPluginPin | undefined,
  current?: () => boolean,
): Promise<{ terminal: Promise<FeatureFixTerminal> }> {
  const started = await dispatchDefaultFix(pi, ctx, '', input, { pluginPin, continuationCurrent: current })
  const owned = ownedFixRunFor(pi)
  return owned === undefined
    ? { terminal: Promise.resolve(unownedFeatureFixTerminal(started)) }
    : { terminal: owned.run.terminal }
}

export async function loadInstalledFeatureWorkflow(
  report: (message: string) => void,
  options: FeatureCommandOptions,
): Promise<FeatureWorkflow | undefined> {
  try {
    return options.featureWorkflow ?? (await loadFeatureWorkflow())
  } catch (error) {
    report(`feature-stopped: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

export function createFeatureCommandHost(
  composition: FeatureCommandComposition,
  binding: FramingCommandBinding,
  workflow: FeatureWorkflow,
  controller: NativeBatchController,
  uw: FeatureCommandHost['uw'],
  report: FeatureOperationReportGuard,
  pluginPin: TrustedHostPluginPin | undefined,
  ingressNativeEpoch: number,
): FeatureCommandHost {
  const { pi, options, interruptOwnedFeatureWork, framing } = composition
  const { ctx } = binding
  const operationGeneration = featureOperationGeneration(pi)
  const operationCurrent = (owner: object | null | undefined, inherited?: () => boolean): boolean =>
    report.isCurrent() &&
    featureOperationGeneration(pi) === operationGeneration &&
    ownedFeatureFor(pi) === owner &&
    (inherited?.() ?? true)
  const preparationCurrent = (owner: object | null | undefined, inherited?: () => boolean): boolean =>
    operationCurrent(owner, inherited) && controller.featureContinuationEpoch() === ingressNativeEpoch
  const dispatchCurrent = (owner: object | null | undefined, inherited?: () => boolean): boolean =>
    preparationCurrent(owner, inherited) && !controller.featureContinuationInhibited()
  const fixCurrent = (current?: FeatureCurrent): FeatureCurrent => {
    let owner = ownedFeatureFor(pi)
    const guard: FeatureCurrent = () => dispatchCurrent(owner, current)
    guard.transfer = (successor) => {
      owner = successor
      current?.transfer?.(successor)
    }
    return guard
  }
  const native = createNativeReviewPort(pi, controller)
  return {
    key: pi,
    cwd: ctx.cwd,
    principal: options.principalCwd?.(ctx.cwd) ?? isInstalledPrincipal(ctx.cwd),
    workflow: {
      ...workflow,
      continueFeature(input) {
        const owner = ownedFeatureFor(pi)
        const inherited = input.owned
        // Pause/abandon stay operation-generation/origin bound only; their own inhibits advance the latch epoch.
        const current = () =>
          input.control === 'pause' || input.control === 'abandon'
            ? operationCurrent(owner, inherited)
            : preparationCurrent(owner, inherited)
        return workflow.continueFeature({
          ...input,
          owned: current,
          ...(input.contextHandoff === undefined
            ? {}
            : { contextEffectObserverFactory: ownedContextEffectObserverFactory(ctx, current) }),
        })
      },
    },
    native: {
      ...native,
      activate(batch, callbacks) {
        if (!dispatchCurrent(ownedFeatureFor(pi))) throw new Error('feature operation origin is no longer current')
        native.activate(batch, callbacks)
      },
      async announce(batch, current) {
        if (!dispatchCurrent(ownedFeatureFor(pi), current)) {
          await native.stopOwned(batch, 'feature-operation-origin-changed')
          throw new Error('feature operation origin is no longer current')
        }
        await native.announce(batch, () => dispatchCurrent(ownedFeatureFor(pi), current))
      },
    },
    send: async (message) => {
      if (report.isCurrent()) reportFeatureTerminalStatus(pi, message)
    },
    status: (message) => {
      if (report.isCurrent()) ctx.ui?.setStatus?.('omp-build-watch', message)
    },
    startFraming: (source) => framing.start(binding, source, report.handoff),
    requestParentCoverage: (request) => requestParentCoverage(ctx, request),
    inhibitFeatureContinuation: () => controller.inhibitFeatureContinuation(),
    releaseFeatureContinuation: () =>
      report.isCurrent() &&
      featureOperationGeneration(pi) === operationGeneration &&
      controller.releaseFeatureContinuation(ingressNativeEpoch),
    featureContinuationInhibited: () => controller.featureContinuationInhibited(),
    markFeatureBatch: (batch) => controller.markFeatureBatch(batch),
    ...(uw === undefined ? {} : { uw }),
    ...(pluginPin === undefined ? {} : { pluginPin }),
    interruptOwnedWork: interruptOwnedFeatureWork,
    startReview: (args, onComplete, current) =>
      dispatchDefaultReview(pi, ctx, args, {
        onComplete,
        prepareReview: options.prepareReview,
        pluginPin,
        scopedGuard: () => dispatchCurrent(ownedFeatureFor(pi), current),
      }),
    prepareEpicRangeReview: (review, onComplete) => prepareInstalledEpicRangeReview(pi, review, onComplete),
    exec: (command, args, executionOptions) => pi.exec(command, args, executionOptions),
    startFix: async (input, current) => {
      const featureCurrent = fixCurrent(current)
      if (!featureCurrent()) throw new Error('feature-fix-continuation-inhibited')
      const started =
        options.startFeatureFix === undefined
          ? await startInstalledFeatureFix(pi, ctx, input, pluginPin, featureCurrent)
          : await options.startFeatureFix(input)
      return { terminal: started.terminal, current: featureCurrent }
    },
    startAdmittedCiCorrection: async (input, current) => {
      const featureCurrent = fixCurrent(current)
      if (!featureCurrent()) throw new Error('feature-fix-continuation-inhibited')
      const run = await dispatchAdmittedCiCorrection(pi, ctx, input, { pluginPin, continuationCurrent: featureCurrent })
      return { terminal: run.terminal, current: featureCurrent }
    },
  }
}
