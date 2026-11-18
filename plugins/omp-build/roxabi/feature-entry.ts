import type { NativeSuccessor } from '../omp/review-runtime/contracts.ts'
import { parseFeatureCommand, runTrustedFeatureInit } from './feature-command.ts'
import type { ContinueFeatureInput, ContinueFeatureResult, FeatureCommandHost } from './feature-contract.ts'
import { correctionSuccessor } from './feature-correction-successor.ts'
import { continueWithParentCoverage } from './feature-coverage-continuation.ts'
import { continueAfterAdmittedCiCorrection, continueAfterFix } from './feature-entry-correction.ts'
import { deliverPrincipalRefusal, preservesFeatureResult, settleStoppedOwner } from './feature-entry-stops.ts'
import { deliverEpicFinalReview } from './feature-epic-delivery.ts'
import { announceFeatureBatch } from './feature-host-native.ts'
import {
  type FeatureCurrent,
  featureCurrent,
  ownedFeatureFor,
  releaseFeatureOwner,
  rememberFeatureOwner,
} from './feature-host-ownership.ts'
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
    ...(parsed.control === 'recover-context' ? { contextRecovery: { actionFile: parsed.actionFile } } : {}),
    ...('contextHandoff' in parsed && parsed.contextHandoff !== undefined
      ? { contextHandoff: parsed.contextHandoff }
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
  const principalDispatch =
    host.principal &&
    (control === 'select' || control === 'resume' || control === 'new' || control === 'recover-context')
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
  const withCoverage = await continueWithParentCoverage(host, commandInput, result, principalDispatch)
  if (withCoverage === undefined) return
  result = withCoverage
  if (principalDispatch) {
    await deliverPrincipalRefusal(host, result)
    return
  }
  // recover-context never unlocks the native latch. Legacy select/resume keep
  // generation-bound release for non-framing outcomes (incl. blocked missing-context).
  // F5 `new` admits only authenticated runnable results after coverage.
  const mayRelease = control === 'new' ? isRunnableFeatureResult(result) : control === 'select' || control === 'resume'
  const admitted = !mayRelease || host.releaseFeatureContinuation()
  await deliverFeatureResult(commandInput.reference, result, host, () => admitted)
}

export function isRunnableFeatureResult(result: ContinueFeatureResult): boolean {
  return (
    result.kind === 'action' ||
    result.kind === 'watch' ||
    result.kind === 'review' ||
    result.kind === 'fix' ||
    result.kind === 'admitted-ci-correction' ||
    result.kind === 'epic-final-review'
  )
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
  current?: FeatureCurrent,
): Promise<void> {
  if (current?.() === false) {
    if (result.kind === 'action') recordStartNotActivated(result.start)
    return
  }
  if (result.kind === 'framing') {
    await host.startFraming(result.source, result.source.kind === 'free-text' ? result.source.acceptedArgs : reference)
    return
  }
  if (host.featureContinuationInhibited() && !preservesFeatureResult(result)) {
    if (result.kind === 'action') recordStartNotActivated(result.start)
    return await host.send('feature-stopped: continuation-inhibited')
  }
  if (result.kind === 'session-cwd') return deliverSessionCwd(result, host)
  const stop = presentFeatureResult(reference, result, host)
  if (stop !== null) {
    await host.send(stop)
    return
  }
  switch (result.kind) {
    case 'action':
      await announceFeatureBatch(
        reference,
        result.followUp,
        result.start,
        host,
        async (next, originCurrent) => deliverFeatureResult(reference, next, host, originCurrent),
        current,
      )
      return
    case 'watch':
      return deliverFeatureWatch(reference, result, host)
    case 'review':
      return deliverFeatureReview(reference, result, host, current)
    case 'fix':
      return continueAfterFix(reference, result, host, deliverFeatureResult, current)
    case 'admitted-ci-correction':
      return continueAfterAdmittedCiCorrection(reference, result, host, deliverFeatureResult, current)
    case 'epic-final-review':
      return deliverEpicFinalReview(result, host, continueAfterReview)
    default:
      await host.send('feature-stopped: feature-result-invalid')
  }
}

function presentFeatureResult(
  reference: string,
  result: ContinueFeatureResult,
  host: FeatureCommandHost,
): string | null {
  settleStoppedOwner(reference, result, host)
  if (result.kind === 'blocked' || result.kind === 'paused') host.status(featureResultStatus(reference, result))
  else if (result.kind === 'terminal' || (result.kind === 'abandoned' && result.confirmed)) host.status(undefined)
  return featureStopMessage(result)
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
  current?: FeatureCurrent,
): Promise<void> {
  if (host.startReview === undefined) {
    await host.send('feature-stopped: review-unavailable')
    return
  }
  const previousOwner = ownedFeatureFor(host.key)
  let expectedOwner = previousOwner
  const owner = { reference, cwd: host.cwd, pausable: true }
  try {
    await host.startReview(
      String(result.pr),
      (canContinue) =>
        continueAfterReview(
          reference,
          host,
          featureCurrent(host.key, owner, () => canContinue() && !host.featureContinuationInhibited()),
        ),
      () => current?.() !== false && ownedFeatureFor(host.key) === expectedOwner,
    )
    if (current?.() === false || ownedFeatureFor(host.key) !== previousOwner) return
    rememberFeatureOwner(host.key, owner)
    expectedOwner = owner
    current?.transfer?.(owner)
  } catch (error) {
    if (ownedFeatureFor(host.key) === owner) releaseFeatureOwner(host.key)
    throw error
  }
}

async function continueAfterReview(
  reference: string,
  host: FeatureCommandHost,
  canContinue: FeatureCurrent,
): Promise<NativeSuccessor | undefined> {
  const current = canContinue
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
  await deliverFeatureResult(reference, next, host, current)
}
