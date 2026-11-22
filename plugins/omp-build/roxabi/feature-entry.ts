import type { NativeSuccessor } from '../omp/review-runtime/contracts.ts'
import { parseFeatureCommand, runTrustedFeatureInit } from './feature-command.ts'
import type {
  ContinueFeatureInput,
  ContinueFeatureResult,
  FeatureCommandHost,
  FeatureFixTerminal,
} from './feature-contract.ts'
import { correctionSuccessor } from './feature-correction-successor.ts'
import { continueWithParentCoverage } from './feature-coverage-continuation.ts'
import { deliverPrincipalRefusal, preservesFeatureResult, settleStoppedOwner } from './feature-entry-stops.ts'
import { deliverEpicFinalReview } from './feature-epic-delivery.ts'
import { announceFeatureBatch } from './feature-host-native.ts'
import { ownedFeatureFor, releaseFeatureOwner, rememberFeatureOwner } from './feature-host-ownership.ts'
import { startInstalledFeatureWatch } from './feature-host-watch.ts'
import { withFeatureInterruption } from './feature-pause-interruption.ts'
import {
  featureErrorMessage,
  featureResultStatus,
  featureStopMessage,
  principalRefusalMessage,
} from './feature-presentation.ts'
import { deliverSessionCwd } from './feature-session-cwd.ts'
import { recordStartNotActivated } from './feature-start-executions.ts'

export async function runInstalledFeatureCommand(args: string, host: FeatureCommandHost): Promise<void> {
  const parsed = parseFeatureCommand(args)
  if (!parsed.ok) {
    await host.send(`feature-stopped: ${parsed.reason}`)
    return
  }
  if (parsed.control === 'init') {
    await runTrustedFeatureInit(parsed.args, host)
    return
  }
  const commandInput: ContinueFeatureInput = {
    cwd: host.cwd,
    reference: parsed.reference,
    control: parsed.control,
    principal: host.principal,
    ...(host.uw === undefined ? {} : { uw: host.uw }),
    ...(host.pluginPin === undefined ? {} : { pluginPin: host.pluginPin }),
    ...(parsed.control === 'resolve-interruption'
      ? { interruption: { ...(parsed.start === undefined ? {} : { start: parsed.start }) } }
      : {}),
  }
  await withFeatureInterruption(parsed.control, host, (preserveFailure) =>
    continueFeatureCommand(args, commandInput, host, preserveFailure),
  )
}

/** Dispatches the classified source before any delivery-only coverage or principal gate. */
async function continueFeatureCommand(
  args: string,
  commandInput: ContinueFeatureInput,
  host: FeatureCommandHost,
  preserveFailure = false,
): Promise<void> {
  const control = commandInput.control
  const principalDispatch = host.principal && (control === 'select' || control === 'resume' || control === 'new')
  let result: ContinueFeatureResult
  try {
    result = await host.workflow.continueFeature(commandInput)
  } catch (error) {
    await reportFeatureFailure(host, principalDispatch, error)
    if (preserveFailure) throw error
    return
  }
  if (control === 'resolve-interruption') {
    await deliverInterruptionResult(commandInput.reference, result, host)
    return
  }
  if (result.kind === 'framing') {
    await host.startFraming(
      result.source.kind === 'free-text' ? { kind: 'free-text', acceptedArgs: args } : result.source,
      args,
    )
    return
  }
  if (control === 'select' || control === 'resume' || control === 'new') host.releaseFeatureContinuation()
  const withCoverage = await continueWithParentCoverage(host, commandInput, result, principalDispatch)
  if (withCoverage === undefined) return
  result = withCoverage
  if (principalDispatch) {
    await deliverPrincipalRefusal(host, result)
    return
  }
  await deliverFeatureResult(commandInput.reference, result, host)
}

async function reportFeatureFailure(host: FeatureCommandHost, principal: boolean, error: unknown): Promise<void> {
  const stop = featureErrorMessage(error)
  try {
    await host.send(principal ? principalRefusalMessage(host.cwd, stop) : stop)
  } catch (notification) {
    throw new AggregateError([error, notification], 'Feature failure and notification failed', { cause: error })
  }
}

async function deliverInterruptionResult(
  reference: string,
  result: ContinueFeatureResult,
  host: FeatureCommandHost,
): Promise<void> {
  const message = featureStopMessage(result) ?? 'feature-stopped: interruption-result-invalid'
  await host.send(
    result.kind === 'paused' && result.confirmed && result.reason === 'interruption-resolved'
      ? `${message}\nUW ${reference} remains paused · next: /feature resume ${reference}`
      : message,
  )
}

export async function deliverFeatureResult(
  reference: string,
  result: ContinueFeatureResult,
  host: FeatureCommandHost,
  current?: () => boolean,
): Promise<void> {
  if (result.kind === 'framing') {
    await host.startFraming(result.source, result.source.kind === 'free-text' ? result.source.acceptedArgs : reference)
    return
  }
  if (host.featureContinuationInhibited() && !preservesFeatureResult(result)) {
    if (result.kind === 'action') recordStartNotActivated(result.start)
    return await host.send('feature-stopped: continuation-inhibited')
  }
  if (result.kind === 'session-cwd') return deliverSessionCwd(result, host)
  settleStoppedOwner(reference, result, host)
  if (result.kind === 'blocked' || result.kind === 'paused') host.status(featureResultStatus(reference, result))
  else if (result.kind === 'terminal' || (result.kind === 'abandoned' && result.confirmed)) host.status(undefined)
  const stop = featureStopMessage(result)
  if (stop !== null) {
    await host.send(stop)
    return
  }
  switch (result.kind) {
    case 'action':
      await announceFeatureBatch(reference, result.followUp, result.start, host, async (next, originCurrent) =>
        deliverFeatureResult(reference, next, host, originCurrent),
      )
      return
    case 'watch':
      return deliverFeatureWatch(reference, result, host)
    case 'review':
      return deliverFeatureReview(reference, result, host)
    case 'fix':
      return continueAfterFix(reference, result, host, current)
    case 'admitted-ci-correction':
      return continueAfterAdmittedCiCorrection(reference, result, host, current)
    case 'epic-final-review':
      return deliverEpicFinalReview(result, host, continueAfterReview)
    default:
      await host.send('feature-stopped: feature-result-invalid')
  }
}

async function deliverFeatureWatch(
  reference: string,
  result: Extract<ContinueFeatureResult, { kind: 'watch' }>,
  host: FeatureCommandHost,
): Promise<void> {
  if (host.principal || host.featureContinuationInhibited()) {
    await host.send('feature-stopped: continuation-inhibited')
    return
  }
  await startInstalledFeatureWatch(reference, result.command, host, async (next) =>
    deliverFeatureResult(reference, next, host),
  )
}

async function deliverFeatureReview(
  reference: string,
  result: Extract<ContinueFeatureResult, { kind: 'review' }>,
  host: FeatureCommandHost,
): Promise<void> {
  if (host.startReview === undefined) {
    await host.send('feature-stopped: review-unavailable')
    return
  }
  const owner = { reference, cwd: host.cwd, pausable: true }
  rememberFeatureOwner(host.key, owner)
  try {
    await host.startReview(String(result.pr), (canContinue) =>
      continueAfterReview(reference, host, () => canContinue() && ownedFeatureFor(host.key) === owner),
    )
  } catch (error) {
    releaseFeatureOwner(host.key)
    throw error
  }
}

async function continueAfterReview(
  reference: string,
  host: FeatureCommandHost,
  canContinue: () => boolean,
): Promise<NativeSuccessor | undefined> {
  const current = () => canContinue() && !host.featureContinuationInhibited()
  if (!current()) return
  const next = await host.workflow.continueFeature({
    cwd: host.cwd,
    reference,
    control: 'continue',
    principal: false,
    owned: current,
    ...(host.uw === undefined ? {} : { read: host.uw, uw: host.uw }),
    ...(host.pluginPin === undefined ? {} : { pluginPin: host.pluginPin }),
  })
  if (!current()) {
    if (next.kind === 'action') recordStartNotActivated(next.start)
    return
  }
  if (next.kind === 'fix' || next.kind === 'admitted-ci-correction')
    return correctionSuccessor(next, host, current, (result, guard) =>
      deliverFeatureResult(reference, result, host, guard),
    )
  await deliverFeatureResult(reference, next, host)
}

function observeFeatureTerminal(
  reference: string,
  host: FeatureCommandHost,
  terminal: Promise<FeatureFixTerminal>,
  current: () => boolean,
): void {
  const owns = () => current() && !host.featureContinuationInhibited()
  void terminal
    .then(async (result) => {
      if (result.status !== 'complete' || !owns()) return
      const next = await host.workflow.continueFeature({
        cwd: host.cwd,
        reference,
        control: 'continue',
        principal: false,
        owned: owns,
        ...(host.uw === undefined ? {} : { read: host.uw, uw: host.uw }),
        ...(host.pluginPin === undefined ? {} : { pluginPin: host.pluginPin }),
      })
      if (!owns()) {
        if (next.kind === 'action') recordStartNotActivated(next.start)
        return
      }
      await deliverFeatureResult(reference, next, host, owns)
    })
    .catch(async (error: unknown) => {
      if (owns()) await host.send(featureErrorMessage(error))
    })
}

async function continueAfterFix(
  reference: string,
  fix: Extract<ContinueFeatureResult, { kind: 'fix' }>,
  host: FeatureCommandHost,
  current?: () => boolean,
): Promise<void> {
  if (host.startFix === undefined) {
    await host.send('feature-stopped: fix-unavailable')
    return
  }
  const run = await host.startFix(fix, current)
  observeFeatureTerminal(reference, host, run.terminal, run.current)
}

async function continueAfterAdmittedCiCorrection(
  reference: string,
  result: Extract<ContinueFeatureResult, { kind: 'admitted-ci-correction' }>,
  host: FeatureCommandHost,
  current?: () => boolean,
): Promise<void> {
  if (host.startAdmittedCiCorrection === undefined) {
    await host.send('feature-stopped: ci-correction-unavailable')
    return
  }
  const run = await host.startAdmittedCiCorrection(
    {
      reference: result.reference,
      attributionRecordId: result.attributionRecordId,
      uw: result.uw,
    },
    current,
  )
  observeFeatureTerminal(reference, host, run.terminal, run.current)
}
