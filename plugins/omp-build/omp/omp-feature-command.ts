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
import { type CommandOperatorPort, createOperatorConfirmation } from './omp-operator-confirmation.ts'

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
  const controller = reviewControllerFor(pi)
  controller.observeRootContext(ctx)
  if (parsed.control === 'init') {
    const operator = beginFeatureUwOperation(pi, createOperatorConfirmation(ctx))
    try {
      await runTrustedFeatureInit(parsed.args, {
        cwd: ctx.cwd,
        send: async (message) => reportFeatureTerminalStatus(pi, message),
        exec: (command, commandArgs, executionOptions) => pi.exec(command, commandArgs, executionOptions),
      })
    } finally {
      cancelFeatureUwOperation(pi, operator)
    }
    return
  }
  // Read-only from here, before any await, until the source is classified.
  const operator = beginFeatureUwIntake(pi, createOperatorConfirmation(ctx), ctx)
  try {
    const workflow = await loadInstalledFeatureWorkflow(pi, options)
    if (!ownsFeatureUwOperation(pi, operator)) return
    if (workflow === undefined) {
      cancelFeatureUwOperation(pi, operator)
      return
    }
    let uw: FeatureCommandHost['uw']
    if (parsed.control !== 'pause' && options.featureWorkflow === undefined) {
      try {
        uw = await resolveFeatureUw(ctx, operator, options.uwOperations, options.pluginPin)
      } catch (error) {
        cancelFeatureUwOperation(pi, operator)
        throw error
      }
    }
    if (!ownsFeatureUwOperation(pi, operator)) return
    try {
      await runInstalledFeatureCommand(
        args,
        createFeatureCommandHost(
          composition,
          { ctx, operator, originalArgs: args },
          classifyingWorkflow(workflow, () => settleFeatureUwIntake(pi, operator)),
          controller,
          uw,
        ),
      )
    } catch (error) {
      cancelFeatureUwOperation(pi, operator)
      throw error
    }
  } finally {
    // An entry that ended unclassified (refusal, stale replacement) never stays read-only.
    settleFeatureUwIntake(pi, operator)
  }
}

/**
 * Root's fresh ordinary continuation after the human-attested `/move`: it explicitly replaces the
 * framing lease, then runs the verified continuation once and delivers it like a `/feature` entry.
 * The replaced lease is already finalized, so failures are reported here as a terminal stop.
 */
export async function continueFramedFeature(
  composition: FeatureCommandComposition,
  input: Readonly<{ ctx: ExtensionContext; continuation: ContinueFeatureInput; operator: CommandOperatorPort }>,
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
