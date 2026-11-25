import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { parseFeatureCommand, runTrustedFeatureInit } from '../roxabi/feature-command.ts'
import type {
  ContinueFeatureInput,
  FeatureCommandHost,
  FeatureWorkflow,
  ParsedFeatureCommand,
} from '../roxabi/feature-contract.ts'
import type { FramingOperator } from '../roxabi/feature-framing-contract.ts'
import { featureErrorMessage } from '../roxabi/feature-presentation.ts'
import type { TrustedHostPluginPin } from '../roxabi/uw-action-contract.ts'
import { hostPluginPin } from './host-plugin-pin.ts'
import { resolveFeatureUw } from './host-uw-operations.ts'
import { type OmpBuildExtensionApi, reportFeatureTerminalStatus } from './omp-controller'
import { admitFeature } from './omp-feature-admission.ts'
import {
  beginFeatureUwContinuation,
  beginFeatureUwIntake,
  beginFeatureUwOperation,
  cancelFeatureUwOperation,
  createFeatureOperationReportGuard,
  type FeatureOperationReportGuard,
  settleFeatureUwIntake,
} from './omp-feature-composition.ts'
import { deliverAdmission, deliversSkill } from './omp-feature-delivery.ts'
import { takeRunningFeature } from './omp-feature-run.ts'
import { rootContext } from './omp-feature-session'
import type { FeatureFramingRuntime } from './omp-framing-runtime.ts'
import { type CommandOperatorPort, createOperatorConfirmation, raceOperatorHold } from './omp-operator-confirmation.ts'
import { nativeText } from './omp-operator-confirmation-field.ts'
import { notifyOperator } from './omp-operator-confirmation-presenter.ts'
import { readSkillBody } from './omp-skill-command-runtime.ts'
import type { UwOperationsFactory } from './omp-uw-command.ts'

export type FeatureCommandOptions = {
  uwOperations?: UwOperationsFactory
  pluginPin?: TrustedHostPluginPin
  featureWorkflow?: FeatureWorkflow
  principalCwd?: (cwd: string) => boolean
}

export type FeatureCommandComposition = Readonly<{
  pi: OmpBuildExtensionApi
  options: FeatureCommandOptions
  framing: FeatureFramingRuntime
}>

type FeatureComposition = FeatureCommandComposition & {
  installRoot: string
  skillsDir: string
  exists: (path: string) => boolean
}

const requireFromIndex = createRequire(import.meta.url)

function isPrincipal(composition: FeatureComposition, cwd: string): boolean {
  if (composition.options.principalCwd) return composition.options.principalCwd(cwd)
  try {
    const freeze: { isPrincipalCwd?: (cwd: string) => boolean } = requireFromIndex('../hooks/lib/principal-freeze.cjs')
    return freeze.isPrincipalCwd?.(cwd) === true
  } catch {
    return false
  }
}

async function compositionSkill(composition: FeatureComposition): Promise<string | undefined> {
  const { pi, skillsDir, installRoot, exists } = composition
  const body = await readSkillBody(pi, 'feature', join(skillsDir, 'feature', 'SKILL.md'), installRoot, exists)
  if (body === undefined) return undefined
  const missing = ['dev-review', 'dev-fix'].filter((name) => !exists(join(skillsDir, name, 'SKILL.md')))
  if (missing.length === 0) return body
  reportFeatureTerminalStatus(pi, `/feature: missing installed skill(s) ${missing.join(', ')}. Reinstall omp-build.`)
  return undefined
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
  pluginPin: TrustedHostPluginPin | undefined,
): Promise<FeatureCommandHost['uw']> {
  if (options.featureWorkflow !== undefined) return undefined
  return resolveFeatureUw(ctx, operator, options.uwOperations, pluginPin)
}

async function runClassifiedFeatureCommand(
  composition: FeatureComposition,
  ctx: ExtensionContext,
  operator: FramingOperator,
  input: ContinueFeatureInput,
  body: string | undefined,
  reporting: FeatureOperationReportGuard,
  originalArgs: string | null,
): Promise<void> {
  const { pi, options } = composition
  const settle = () => settleFeatureUwIntake(pi, operator)
  const result =
    options.featureWorkflow === undefined
      ? await admitFeature(input, settle)
      : await options.featureWorkflow.continueFeature(input)
  if (!reporting.isCurrent()) return
  if (result.kind !== 'framing') settle()
  await deliverAdmission(composition, ctx, operator, input, result, body, reporting, originalArgs)
}

async function runFeatureEntry(
  composition: FeatureComposition,
  ctx: ExtensionContext,
  operator: CommandOperatorPort,
  parsed: Extract<ParsedFeatureCommand, { ok: true; control: ContinueFeatureInput['control'] }>,
  reporting: FeatureOperationReportGuard,
  args: string,
): Promise<void> {
  const { pi, options } = composition
  // Read-only until the source is classified.
  beginFeatureUwIntake(pi, operator, ctx)
  const pluginPin = await hostPluginPin(pi, ctx)
  if (!reporting.isCurrent()) return
  const deliver = deliversSkill(parsed.control)
  const body = deliver ? await compositionSkill(composition) : undefined
  if (!reporting.isCurrent() || (deliver && body === undefined)) return
  const uw = await featureCommandUw(ctx, operator, options, pluginPin)
  if (!reporting.isCurrent()) return
  const input: ContinueFeatureInput = {
    cwd: ctx.cwd,
    reference: parsed.reference,
    control: parsed.control,
    principal: isPrincipal(composition, ctx.cwd),
    owned: reporting.isCurrent,
    ...(uw === undefined ? {} : { uw }),
    ...(pluginPin === undefined ? {} : { pluginPin }),
  }
  await runClassifiedFeatureCommand(composition, ctx, operator, input, body, reporting, args)
}

export async function runFeatureCommand(
  args: string,
  ctx: ExtensionContext,
  composition: FeatureComposition,
): Promise<void> {
  const { pi } = composition
  if (!rootContext(ctx)) return
  const parsed = parseFeatureCommand(args)
  if (!parsed.ok) {
    reportFeatureTerminalStatus(pi, `feature-stopped: ${parsed.reason}`)
    return
  }
  if (parsed.control === 'pause') {
    const owner = takeRunningFeature(pi, ctx, parsed.reference)
    if (owner !== null) {
      cancelFeatureUwOperation(pi, owner)
      ctx.abort()
    }
    const status = owner === null ? `feature-not-running: ${parsed.reference}` : 'feature-paused: session only'
    // While streaming, OMP queues even triggerTurn:false transcript messages as steers.
    if (ctx.isIdle()) reportFeatureTerminalStatus(pi, status)
    else ctx.ui?.notify?.(nativeText(status), 'info')
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
      if (parsed.control === 'init') await runPreparedFeatureInit(pi, operator, parsed.args, ctx, report)
      else await runFeatureEntry(composition, ctx, operator, parsed, reporting, args)
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
  composition: FeatureComposition,
  input: Readonly<{ ctx: ExtensionContext; continuation: ContinueFeatureInput; operator: FramingOperator }>,
): Promise<void> {
  const { pi } = composition
  const { ctx, continuation, operator } = input
  if (!rootContext(ctx)) throw new Error('framing-continuation-root-required')
  const reporting = createFeatureOperationReportGuard(pi, ctx, operator)
  beginFeatureUwContinuation(pi, operator, ctx)
  try {
    if (!reporting.isCurrent()) return
    const body = await compositionSkill(composition)
    if (!reporting.isCurrent() || body === undefined) return
    await runClassifiedFeatureCommand(
      composition,
      ctx,
      operator,
      { ...continuation, owned: reporting.isCurrent },
      body,
      reporting,
      null,
    )
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
