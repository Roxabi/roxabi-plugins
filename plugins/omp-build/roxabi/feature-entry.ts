import { realpathSync } from 'node:fs'
import { parseFeatureCommand, runTrustedFeatureInit } from './feature-command.ts'
import type { ContinueFeatureResult, FeatureCommandHost, FeatureFixTerminal } from './feature-contract.ts'
import { deliverEpicFinalReview } from './feature-epic-delivery.ts'
import { announceFeatureBatch } from './feature-host-native.ts'
import { abortOwnedFeatureWatch, releaseFeatureOwner, rememberFeatureOwner } from './feature-host-ownership.ts'
import { startInstalledFeatureWatch } from './feature-host-watch.ts'
import {
  featureErrorMessage,
  featureSessionCwdMessage,
  featureStopMessage,
  isAssistedFraming,
  principalRefusalMessage,
} from './feature-presentation.ts'
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
  } else if (parsed.control === 'select' || parsed.control === 'resume') host.releaseFeatureContinuation()

  const principalDispatch =
    host.principal && (parsed.control === 'select' || parsed.control === 'resume' || parsed.control === 'new')
  let result: ContinueFeatureResult
  try {
    result = await host.workflow.continueFeature({
      cwd: host.cwd,
      reference: parsed.reference,
      control: parsed.control,
      decision: parsed.decision,
      principal: host.principal,
    })
  } catch (error) {
    const stop = featureErrorMessage(error)
    await host.send(principalDispatch ? principalRefusalMessage(host.cwd, stop) : stop)
    return
  }
  if (principalDispatch) {
    await deliverPrincipalRefusal(host, result)
    return
  }
  await deliverFeatureResult(parsed.reference, result, host)
}

/** The principal checkout acts on nothing: it forwards a valid move, otherwise it names what stopped. */
async function deliverPrincipalRefusal(host: FeatureCommandHost, result: ContinueFeatureResult): Promise<void> {
  const stop = featureStopMessage(result)
  if (stop === null && result.kind === 'session-cwd') {
    await host.send(featureSessionCwdMessage(result.path, result.instruction))
    return
  }
  await host.send(principalRefusalMessage(host.cwd, stop ?? `workflow-result: ${result.kind}`))
}
function preservesFeatureResult(result: ContinueFeatureResult): boolean {
  switch (result.kind) {
    case 'session-cwd':
    case 'paused':
    case 'abandoned':
    case 'blocked':
    case 'terminal':
    case 'operator-decision':
      return true
    default:
      return false
  }
}

export async function deliverFeatureResult(
  reference: string,
  result: ContinueFeatureResult,
  host: FeatureCommandHost,
): Promise<void> {
  if (host.featureContinuationInhibited() && !preservesFeatureResult(result))
    return await host.send('feature-stopped: continuation-inhibited')
  if (result.kind === 'session-cwd') return deliverSessionCwd(result, host)
  const stop = featureStopMessage(result)
  if (stop !== null) {
    settleStoppedOwner(reference, result, host)
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

async function deliverSessionCwd(
  result: Extract<ContinueFeatureResult, { kind: 'session-cwd' }>,
  host: FeatureCommandHost,
): Promise<void> {
  const stop = featureStopMessage(result)
  if (stop !== null) {
    await host.send(`session-cwd ${host.cwd}\n${stop}`)
    return
  }
  if (sameRealpath(result.path, host.cwd)) {
    await host.send('feature-stopped: session-cwd-already-current')
    return
  }
  await host.send(featureSessionCwdMessage(result.path, result.instruction))
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

/** Owner bookkeeping a stop leaves behind; its operator text comes from `featureStopMessage`. */
function settleStoppedOwner(reference: string, result: ContinueFeatureResult, host: FeatureCommandHost): void {
  const retained = { reference, cwd: host.cwd, pausable: false }
  switch (result.kind) {
    case 'paused':
      rememberFeatureOwner(host.key, retained)
      return
    case 'abandoned':
      if (result.confirmed === true) releaseFeatureOwner(host.key)
      else rememberFeatureOwner(host.key, retained)
      return
    case 'blocked':
      if (!isAssistedFraming(result.reason)) rememberFeatureOwner(host.key, retained)
      return
    case 'terminal':
      releaseFeatureOwner(host.key)
      return
  }
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
    scope: result.scope,
  })
  observeFeatureTerminal(reference, host, run.terminal)
}

function sameRealpath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right)
  } catch {
    return false
  }
}
