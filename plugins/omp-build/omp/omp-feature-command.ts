import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { parseFeatureCommand, runTrustedFeatureInit } from '../roxabi/feature-command.ts'
import type {
  ContinueFeatureInput,
  ContinueFeatureResult,
  FeatureCommandHost,
  FeatureWorkflow,
} from '../roxabi/feature-contract.ts'
import { continueWithParentCoverage } from '../roxabi/feature-coverage-continuation.ts'
import { deliverFeatureResult, isRunnableFeatureResult, runInstalledFeatureCommand } from '../roxabi/feature-entry.ts'
import type { FramingOperator } from '../roxabi/feature-framing-contract.ts'
import { featureErrorMessage } from '../roxabi/feature-presentation.ts'
import type { TrustedHostPluginPin } from '../roxabi/uw-action-contract.ts'
import { hostPluginPin } from './host-plugin-pin.ts'
import { resolveFeatureUw } from './host-uw-operations.ts'
import { reportFeatureTerminalStatus, reviewControllerFor } from './omp-controller'
import {
  createFeatureCommandHost,
  type FeatureCommandComposition,
  loadInstalledFeatureWorkflow,
} from './omp-feature-command-host.ts'
import {
  beginFeatureUwContinuation,
  beginFeatureUwIntake,
  beginFeatureUwOperation,
  cancelFeatureUwOperation,
  createFeatureOperationReportGuard,
  type FeatureOperationReportGuard,
  ownsFeatureUwOperation,
  settleFeatureUwIntake,
} from './omp-feature-composition.ts'
import { rootContext } from './omp-feature-session'
import { type CommandOperatorPort, createOperatorConfirmation, raceOperatorHold } from './omp-operator-confirmation.ts'
import { notifyOperator } from './omp-operator-confirmation-presenter.ts'
import type { NativeBatchController } from './review-runtime/controller.ts'

/** The intake becomes ordinary once its first classification is not framing, or fails. */
function classifyingWorkflow(workflow: FeatureWorkflow, settle: () => void): FeatureWorkflow {
  return {
    async continueFeature(input) {
      let result: ContinueFeatureResult
      try {
        result = await workflow.continueFeature(input)
      } catch (error) {
        settle()
        throw error
      }
      if (result.kind !== 'framing') settle()
      return result
    },
    consumeWatchExit: (input) => workflow.consumeWatchExit(input),
    publishFeatureNativeResult: (input) => workflow.publishFeatureNativeResult(input),
    requestFeatureSessionPause: (input) => workflow.requestFeatureSessionPause(input),
  }
}

async function runPreparedFeatureInit(
  pi: FeatureCommandComposition['pi'],
  operator: CommandOperatorPort,
  args: readonly string[],
  ctx: ExtensionContext,
  report: (message: string) => void,
): Promise<void> {
  beginFeatureUwOperation(pi, operator)
  await runTrustedFeatureInit(args, {
    cwd: ctx.cwd,
    send: async (message) => report(message),
    exec: (command, commandArgs, executionOptions) => pi.exec(command, commandArgs, executionOptions),
  })
}

async function featureCommandUw(
  ctx: ExtensionContext,
  operator: CommandOperatorPort,
  options: FeatureCommandComposition['options'],
  control: string,
  pluginPin: TrustedHostPluginPin | undefined,
): Promise<FeatureCommandHost['uw']> {
  if (control === 'pause' || options.featureWorkflow !== undefined) return undefined
  return resolveFeatureUw(ctx, operator, options.uwOperations, pluginPin)
}

async function runClassifiedFeatureCommand(
  args: string,
  composition: FeatureCommandComposition,
  ctx: ExtensionContext,
  operator: CommandOperatorPort,
  workflow: FeatureWorkflow,
  controller: NativeBatchController,
  uw: FeatureCommandHost['uw'],
  report: FeatureOperationReportGuard,
  pluginPin: TrustedHostPluginPin | undefined,
  ingressNativeEpoch: number,
): Promise<void> {
  await runInstalledFeatureCommand(
    args,
    createFeatureCommandHost(
      composition,
      { ctx, operator, originalArgs: args, pluginPin },
      classifyingWorkflow(workflow, () => settleFeatureUwIntake(composition.pi, operator)),
      controller,
      uw,
      report,
      pluginPin,
      ingressNativeEpoch,
    ),
  )
}

export async function runFeatureCommand(
  args: string,
  ctx: ExtensionContext,
  composition: FeatureCommandComposition,
): Promise<void> {
  const { pi, options } = composition
  if (!rootContext(ctx)) return
  const parsed = parseFeatureCommand(args)
  if (!parsed.ok) {
    reportFeatureTerminalStatus(pi, `feature-stopped: ${parsed.reason}`)
    return
  }
  const operator = createOperatorConfirmation(ctx)
  operator.progress(parsed.control === 'init' ? '/feature init' : `/feature ${parsed.reference}`)
  const reporting = createFeatureOperationReportGuard(pi, ctx, operator)
  const report = (message: string) => {
    if (!reporting.isCurrent()) return
    reportFeatureTerminalStatus(pi, message)
    notifyOperator(ctx, message)
  }
  let canReportFailure = () => false
  const work = (async () => {
    try {
      const controller = reviewControllerFor(pi)
      controller.observeRootContext(ctx)
      if (parsed.control === 'init') {
        await runPreparedFeatureInit(pi, operator, parsed.args, ctx, report)
        return
      }
      // Capture latch epoch before any await; createFeatureCommandHost is too late after pin/UW loads.
      const ingressNativeEpoch = controller.featureContinuationEpoch()
      // Read-only from here, before any await, until the source is classified.
      beginFeatureUwIntake(pi, operator, ctx)
      const pluginPin = await hostPluginPin(pi, ctx)
      const workflow = await loadInstalledFeatureWorkflow(report, options)
      if (!ownsFeatureUwOperation(pi, operator)) return
      if (workflow === undefined) {
        cancelFeatureUwOperation(pi, operator)
        return
      }
      const uw = await featureCommandUw(ctx, operator, options, parsed.control, pluginPin)
      if (!ownsFeatureUwOperation(pi, operator)) return
      await runClassifiedFeatureCommand(
        args,
        composition,
        ctx,
        operator,
        workflow,
        controller,
        uw,
        reporting,
        pluginPin,
        ingressNativeEpoch,
      )
    } catch (error) {
      canReportFailure = reporting.captureFailure()
      cancelFeatureUwOperation(pi, operator)
      throw error
    } finally {
      if (parsed.control === 'init') cancelFeatureUwOperation(pi, operator)
      // An entry that ended unclassified (refusal, stale replacement) never stays read-only.
      settleFeatureUwIntake(pi, operator)
      operator.progress(null)
      reporting.settleCommand()
    }
  })()
  const reportFailure = (error: unknown): void => {
    if (!canReportFailure()) return
    const message = featureErrorMessage(error)
    reportFeatureTerminalStatus(pi, message)
    notifyOperator(ctx, message, 'error')
  }
  try {
    await raceOperatorHold(work, operator.held, reportFailure)
  } catch (error) {
    reportFailure(error)
  }
}

/**
 * Root's fresh ordinary continuation after the human-attested `/move`: it explicitly replaces the
 * framing lease, then runs the verified continuation once and delivers it like a `/feature` entry.
 * The replaced lease is already finalized, so failures are reported here as a terminal stop.
 */
export async function continueFramedFeature(
  composition: FeatureCommandComposition,
  input: Readonly<{ ctx: ExtensionContext; continuation: ContinueFeatureInput; operator: FramingOperator }>,
): Promise<void> {
  const { pi, options } = composition
  const { ctx, continuation, operator } = input
  if (!rootContext(ctx)) throw new Error('framing-continuation-root-required')
  const reporting = createFeatureOperationReportGuard(pi, ctx, operator)
  const report = (message: string) => {
    if (reporting.isCurrent()) reportFeatureTerminalStatus(pi, message)
  }
  beginFeatureUwContinuation(pi, operator, ctx)
  const controller = reviewControllerFor(pi)
  controller.observeRootContext(ctx)
  const ingressNativeEpoch = controller.featureContinuationEpoch()
  try {
    const workflow = await loadInstalledFeatureWorkflow(report, options)
    if (!ownsFeatureUwOperation(pi, operator)) return
    if (workflow === undefined) {
      cancelFeatureUwOperation(pi, operator)
      return
    }
    const host = createFeatureCommandHost(
      composition,
      { ctx, operator, originalArgs: null, pluginPin: continuation.pluginPin },
      workflow,
      controller,
      continuation.uw,
      reporting,
      continuation.pluginPin,
      ingressNativeEpoch,
    )
    const result = await host.workflow.continueFeature(continuation)
    if (!ownsFeatureUwOperation(pi, operator)) {
      await deliverFeatureResult(continuation.reference, result, host, () => false)
      return
    }
    const withCoverage = await continueWithParentCoverage(host, continuation, result, false)
    if (withCoverage === undefined) return
    const control = continuation.control
    const mayRelease =
      control === 'new' ? isRunnableFeatureResult(withCoverage) : control === 'select' || control === 'resume'
    const admitted = !mayRelease || host.releaseFeatureContinuation()
    await deliverFeatureResult(continuation.reference, withCoverage, host, () => admitted)
  } catch (error) {
    const canReport = reporting.captureFailure()
    cancelFeatureUwOperation(pi, operator)
    if (canReport()) {
      const message = featureErrorMessage(error)
      reportFeatureTerminalStatus(pi, message)
      notifyOperator(ctx, message, 'error')
    }
  } finally {
    reporting.settleCommand()
  }
}
