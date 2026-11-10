import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { parseFeatureCommand, runTrustedFeatureInit } from '../roxabi/feature-command.ts'
import type {
  ContinueFeatureInput,
  ContinueFeatureResult,
  FeatureCommandHost,
  FeatureWorkflow,
} from '../roxabi/feature-contract.ts'
import { continueWithParentCoverage } from '../roxabi/feature-coverage-continuation.ts'
import { deliverFeatureResult, runInstalledFeatureCommand } from '../roxabi/feature-entry.ts'
import type { FramingOperator } from '../roxabi/feature-framing-contract.ts'
import { featureErrorMessage } from '../roxabi/feature-presentation.ts'
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
): Promise<FeatureCommandHost['uw']> {
  if (control === 'pause' || options.featureWorkflow !== undefined) return undefined
  return resolveFeatureUw(ctx, operator, options.uwOperations, options.pluginPin)
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
): Promise<void> {
  await runInstalledFeatureCommand(
    args,
    createFeatureCommandHost(
      composition,
      { ctx, operator, originalArgs: args },
      classifyingWorkflow(workflow, () => settleFeatureUwIntake(composition.pi, operator)),
      controller,
      uw,
      report,
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
  operator.progress('Preparing feature operation')
  const reporting = createFeatureOperationReportGuard(pi, ctx, operator)
  const report = (message: string) => {
    if (reporting.isCurrent()) reportFeatureTerminalStatus(pi, message)
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
      // Read-only from here, before any await, until the source is classified.
      beginFeatureUwIntake(pi, operator, ctx)
      const workflow = await loadInstalledFeatureWorkflow(report, options)
      if (!ownsFeatureUwOperation(pi, operator)) return
      if (workflow === undefined) {
        cancelFeatureUwOperation(pi, operator)
        return
      }
      const uw = await featureCommandUw(ctx, operator, options, parsed.control)
      if (!ownsFeatureUwOperation(pi, operator)) return
      await runClassifiedFeatureCommand(args, composition, ctx, operator, workflow, controller, uw, reporting)
    } catch (error) {
      canReportFailure = reporting.captureFailure()
      cancelFeatureUwOperation(pi, operator)
      throw error
    } finally {
      if (parsed.control === 'init') cancelFeatureUwOperation(pi, operator)
      // An entry that ended unclassified (refusal, stale replacement) never stays read-only.
      settleFeatureUwIntake(pi, operator)
      operator.progress(null)
    }
  })()
  await raceOperatorHold(work, operator.held, (error) => {
    if (!canReportFailure()) return
    reportFeatureTerminalStatus(pi, featureErrorMessage(error))
  })
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
  try {
    const workflow = await loadInstalledFeatureWorkflow(report, options)
    if (!ownsFeatureUwOperation(pi, operator)) return
    if (workflow === undefined) {
      cancelFeatureUwOperation(pi, operator)
      return
    }
    const host = createFeatureCommandHost(
      composition,
      { ctx, operator, originalArgs: null },
      workflow,
      controller,
      continuation.uw,
      reporting,
    )
    const result = await workflow.continueFeature(continuation)
    if (!ownsFeatureUwOperation(pi, operator)) return
    // The framed `/feature` entry deferred its select release until a non-framing classification.
    if (result.kind !== 'framing') host.releaseFeatureContinuation()
    const withCoverage = await continueWithParentCoverage(host, continuation, result, false)
    if (withCoverage === undefined) return
    await deliverFeatureResult(continuation.reference, withCoverage, host)
  } catch (error) {
    const canReport = reporting.captureFailure()
    cancelFeatureUwOperation(pi, operator)
    if (canReport()) reportFeatureTerminalStatus(pi, featureErrorMessage(error))
  }
}
