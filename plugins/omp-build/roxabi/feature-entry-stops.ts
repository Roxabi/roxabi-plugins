import type { ContinueFeatureResult, FeatureCommandHost } from './feature-contract.ts'
import { releaseFeatureOwner, rememberFeatureOwner } from './feature-host-ownership.ts'
import { featureSessionCwdMessage, featureStopMessage, principalRefusalMessage } from './feature-presentation.ts'
import { recordStartNotActivated } from './feature-start-executions.ts'

/** Initial framing precedes this delivery-only principal gate. */
export async function deliverPrincipalRefusal(host: FeatureCommandHost, result: ContinueFeatureResult): Promise<void> {
  if (result.kind === 'action') recordStartNotActivated(result.start)
  const stop = featureStopMessage(result)
  if (stop === null && result.kind === 'session-cwd') {
    await host.send(featureSessionCwdMessage(result.path, result.instruction))
  } else {
    await host.send(principalRefusalMessage(host.cwd, stop ?? refusedWork(result)))
  }
}

/** Work the principal declines to start, named by kind; any other kind is not a workflow result. */
function refusedWork(result: ContinueFeatureResult): string {
  switch (result.kind) {
    case 'action':
    case 'watch':
    case 'review':
    case 'fix':
    case 'admitted-ci-correction':
    case 'epic-final-review':
      return `workflow-result: ${result.kind}`
    default:
      return 'feature-stopped: feature-result-invalid'
  }
}

export function preservesFeatureResult(result: ContinueFeatureResult): boolean {
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

/** Owner bookkeeping a stop leaves behind, a no-op for work; its operator text comes from `featureStopMessage`. */
export function settleStoppedOwner(reference: string, result: ContinueFeatureResult, host: FeatureCommandHost): void {
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
      // A recoverable landing hold stays pausable by its session end; any other block only stays owned.
      rememberFeatureOwner(host.key, {
        ...retained,
        pausable: result.next !== undefined && !host.featureContinuationInhibited(),
      })
      return
    case 'terminal':
      releaseFeatureOwner(host.key)
      return
  }
}
