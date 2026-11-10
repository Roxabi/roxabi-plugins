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

function sameCommand(ctx: ExtensionContext, cwd: string, sessionId: string | undefined): boolean {
  if (ctx.cwd !== cwd) return false
  try {
    return ctx.sessionManager.getSessionId() === sessionId
  } catch {
    return false
  }
}

async function runPreparedFeatureInit(
  pi: FeatureCommandComposition['pi'],
  operator: CommandOperatorPort,
  args: readonly string[],
  ctx: ExtensionContext,
): Promise<void> {
  beginFeatureUwOperation(pi, operator)
  try {
    await runTrustedFeatureInit(args, {
      cwd: ctx.cwd,
      send: async (message) => reportFeatureTerminalStatus(pi, message),
      exec: (command, commandArgs, executionOptions) => pi.exec(command, commandArgs, executionOptions),
    })
  } finally {
    cancelFeatureUwOperation(pi, operator)
  }
}

async function featureCommandUw(
  ctx: ExtensionContext,
  operator: CommandOperatorPort,
  options: FeatureCommandComposition['options'],
  pi: FeatureCommandComposition['pi'],
  control: string,
): Promise<FeatureCommandHost['uw']> {
  if (control === 'pause' || options.featureWorkflow !== undefined) return undefined
  try {
    return await resolveFeatureUw(ctx, operator, options.uwOperations, options.pluginPin)
  } catch (error) {
    cancelFeatureUwOperation(pi, operator)
    throw error
  }
}

async function runClassifiedFeatureCommand(
  args: string,
  composition: FeatureCommandComposition,
  ctx: ExtensionContext,
  operator: CommandOperatorPort,
  workflow: FeatureWorkflow,
  controller: NativeBatchController,
  uw: FeatureCommandHost['uw'],
): Promise<void> {
  try {
    await runInstalledFeatureCommand(
      args,
      createFeatureCommandHost(
        composition,
        { ctx, operator, originalArgs: args },
        classifyingWorkflow(workflow, () => settleFeatureUwIntake(composition.pi, operator)),
        controller,
        uw,
      ),
    )
  } catch (error) {
    cancelFeatureUwOperation(composition.pi, operator)
    throw error
  }
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
  const cwd = ctx.cwd
  let sessionId: string | undefined
  try {
    sessionId = ctx.sessionManager.getSessionId()
  } catch {
    sessionId = undefined
  }
  const work = (async () => {
    const controller = reviewControllerFor(pi)
    controller.observeRootContext(ctx)
    if (parsed.control === 'init') {
      await runPreparedFeatureInit(pi, operator, parsed.args, ctx)
      return
    }
    // Read-only from here, before any await, until the source is classified.
    beginFeatureUwIntake(pi, operator, ctx)
    try {
      const workflow = await loadInstalledFeatureWorkflow(pi, options)
      if (!ownsFeatureUwOperation(pi, operator)) return
      if (workflow === undefined) {
        cancelFeatureUwOperation(pi, operator)
        return
      }
      const uw = await featureCommandUw(ctx, operator, options, pi, parsed.control)
      if (!ownsFeatureUwOperation(pi, operator)) return
      await runClassifiedFeatureCommand(args, composition, ctx, operator, workflow, controller, uw)
    } finally {
      // An entry that ended unclassified (refusal, stale replacement) never stays read-only.
      settleFeatureUwIntake(pi, operator)
    }
  })()
  await raceOperatorHold(work, operator.held, (error) => {
    if (!sameCommand(ctx, cwd, sessionId) || !ownsFeatureUwOperation(pi, operator)) return
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
  beginFeatureUwContinuation(pi, operator, ctx)
  const controller = reviewControllerFor(pi)
  controller.observeRootContext(ctx)
  try {
    const workflow = await loadInstalledFeatureWorkflow(pi, options)
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
    )
    const result = await workflow.continueFeature(continuation)
    if (!ownsFeatureUwOperation(pi, operator)) return
    // The framed `/feature` entry deferred its select release until a non-framing classification.
    if (result.kind !== 'framing') host.releaseFeatureContinuation()
    const withCoverage = await continueWithParentCoverage(host, continuation, result, false)
    if (withCoverage === undefined) return
    await deliverFeatureResult(continuation.reference, withCoverage, host)
  } catch (error) {
    cancelFeatureUwOperation(pi, operator)
    reportFeatureTerminalStatus(pi, featureErrorMessage(error))
  }
}
