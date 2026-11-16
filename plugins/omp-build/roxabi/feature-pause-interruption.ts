import { type JoinedNativeStop, throwJoinedStopFailures } from '../omp/review-runtime/controller-stop.ts'
import type { FeatureCommandHost, FeatureControl } from './feature-contract.ts'
import { abortOwnedFeatureWatch } from './feature-host-ownership.ts'

/** Join local work before control; only pause may proceed after a joined stop failure. */
export async function withFeatureInterruption(
  control: FeatureControl,
  host: FeatureCommandHost,
  run: (preserveFailure: boolean) => Promise<void>,
): Promise<void> {
  let joinedStop: JoinedNativeStop | undefined
  if (control === 'pause' || control === 'abandon') {
    abortOwnedFeatureWatch(host.key)
    host.inhibitFeatureContinuation()
    const interruption = await host.interruptOwnedWork?.(control)
    if (interruption !== undefined) joinedStop = interruption
    if (control !== 'pause' && joinedStop !== undefined) throwJoinedStopFailures(joinedStop)
  }
  try {
    await run((joinedStop?.failures.length ?? 0) > 0)
  } catch (error) {
    if (joinedStop !== undefined && joinedStop.failures.length > 0)
      throw new AggregateError([...joinedStop.failures, error], 'Feature pause and native stop failed')
    throw error
  }
  if (joinedStop !== undefined) throwJoinedStopFailures(joinedStop)
}
