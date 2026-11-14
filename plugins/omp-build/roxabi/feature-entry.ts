import { parseFeatureCommand, runTrustedFeatureInit } from './feature-command.ts'
import type {
  ContinueFeatureInput,
  ContinueFeatureResult,
  FeatureCommandHost,
  FeatureFixTerminal,
} from './feature-contract.ts'
import { continueWithParentCoverage } from './feature-coverage-continuation.ts'
import { deliverPrincipalRefusal, preservesFeatureResult, settleStoppedOwner } from './feature-entry-stops.ts'
import { deliverEpicFinalReview } from './feature-epic-delivery.ts'
import { announceFeatureBatch } from './feature-host-native.ts'
import { abortOwnedFeatureWatch, releaseFeatureOwner, rememberFeatureOwner } from './feature-host-ownership.ts'
import { startInstalledFeatureWatch } from './feature-host-watch.ts'
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
  const stopsContinuation = parsed.control === 'pause' || parsed.control === 'abandon'
  if (stopsContinuation) {
    abortOwnedFeatureWatch(host.key)
    host.inhibitFeatureContinuation()
    await host.interruptOwnedWork?.(parsed.control)
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
  await continueFeatureCommand(args, commandInput, host)
}

/** Dispatches the classified source before any delivery-only coverage or principal gate. */
async function continueFeatureCommand(
  args: string,
  commandInput: ContinueFeatureInput,
  host: FeatureCommandHost,
): Promise<void> {
  const control = commandInput.control
  const principalDispatch = host.principal && (control === 'select' || control === 'resume' || control === 'new')
  let result: ContinueFeatureResult
  try {
    result = await host.workflow.continueFeature(commandInput)
  } catch (error) {
    const stop = featureErrorMessage(error)
    await host.send(principalDispatch ? principalRefusalMessage(host.cwd, stop) : stop)
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
  if (control === 'select' || control === 'resume') host.releaseFeatureContinuation()
  const withCoverage = await continueWithParentCoverage(host, commandInput, result, principalDispatch)
  if (withCoverage === undefined) return
  result = withCoverage
  if (principalDispatch) {
    await deliverPrincipalRefusal(host, result)
    return
  }
  await deliverFeatureResult(commandInput.reference, result, host)
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
      await announceFeatureBatch(reference, result.followUp, result.start, host, async (next) =>
        deliverFeatureResult(reference, next, host),
      )
      return
    case 'watch':
      return deliverFeatureWatch(reference, result, host)
    case 'review':
      return deliverFeatureReview(reference, result, host)
    case 'fix':
      return continueAfterFix(reference, result, host)
    case 'admitted-ci-correction':
      return continueAfterAdmittedCiCorrection(reference, result, host)
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
  rememberFeatureOwner(host.key, { reference, cwd: host.cwd, pausable: true })
  try {
    await host.startReview(String(result.pr), () => continueAfterReview(reference, host))
  } catch (error) {
    releaseFeatureOwner(host.key)
    throw error
  }
}

async function continueAfterReview(reference: string, host: FeatureCommandHost): Promise<void> {
  if (host.featureContinuationInhibited()) return
  const next = await host.workflow.continueFeature({
    cwd: host.cwd,
    reference,
    control: 'continue',
    principal: false,
    ...(host.uw === undefined ? {} : { read: host.uw, uw: host.uw }),
    ...(host.pluginPin === undefined ? {} : { pluginPin: host.pluginPin }),
  })
  await deliverFeatureResult(reference, next, host)
}

function observeFeatureTerminal(
  reference: string,
  host: FeatureCommandHost,
  terminal: Promise<FeatureFixTerminal>,
): void {
  void terminal
    .then(async (result) => {
      if (result.status !== 'complete' || host.featureContinuationInhibited()) return
      const next = await host.workflow.continueFeature({
        cwd: host.cwd,
        reference,
        control: 'continue',
        principal: false,
        ...(host.uw === undefined ? {} : { read: host.uw, uw: host.uw }),
        ...(host.pluginPin === undefined ? {} : { pluginPin: host.pluginPin }),
      })
      await deliverFeatureResult(reference, next, host)
    })
    .catch(async (error: unknown) => {
      await host.send(featureErrorMessage(error))
    })
}

async function continueAfterFix(
  reference: string,
  fix: Extract<ContinueFeatureResult, { kind: 'fix' }>,
  host: FeatureCommandHost,
): Promise<void> {
  if (host.startFix === undefined) {
    await host.send('feature-stopped: fix-unavailable')
    return
  }
  const run = await host.startFix(fix)
  observeFeatureTerminal(reference, host, run.terminal)
}

async function continueAfterAdmittedCiCorrection(
  reference: string,
  result: Extract<ContinueFeatureResult, { kind: 'admitted-ci-correction' }>,
  host: FeatureCommandHost,
): Promise<void> {
  if (host.startAdmittedCiCorrection === undefined) {
    await host.send('feature-stopped: ci-correction-unavailable')
    return
  }
  const run = await host.startAdmittedCiCorrection({
    reference: result.reference,
    attributionRecordId: result.attributionRecordId,
    uw: result.uw,
  })
  observeFeatureTerminal(reference, host, run.terminal)
}
