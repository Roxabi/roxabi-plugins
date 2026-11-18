import { type JoinedNativeStop, throwJoinedStopFailures } from './review-runtime/controller-stop.ts'

/** An unjoinable Fix ingress or failed Fix stop/release cannot certify a completed interruption. */
export async function joinFeatureInterruption(
  native: Promise<JoinedNativeStop>,
  fix: { stop: Promise<void>; release: Promise<void> } | undefined,
  ingressUnknown: boolean,
): Promise<JoinedNativeStop> {
  const [nativeOutcome, stopOutcome, releaseOutcome] = await Promise.allSettled([
    native,
    fix?.stop ?? Promise.resolve(),
    fix?.release ?? Promise.resolve(),
  ])
  const failures: unknown[] = []
  if (nativeOutcome.status === 'rejected') failures.push(nativeOutcome.reason)
  else failures.push(...nativeOutcome.value.failures)
  if (stopOutcome.status === 'rejected') failures.push(stopOutcome.reason)
  if (releaseOutcome.status === 'rejected') failures.push(releaseOutcome.reason)
  if (ingressUnknown) failures.push(new Error('feature-fix-ingress-unjoined'))
  if (
    ingressUnknown ||
    nativeOutcome.status === 'rejected' ||
    stopOutcome.status === 'rejected' ||
    releaseOutcome.status === 'rejected'
  )
    throwJoinedStopFailures({ failures })
  return { failures }
}
