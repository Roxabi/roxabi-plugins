import type { NativeSuccessor } from '../omp/review-runtime/contracts.ts'
import type { ContinueFeatureResult, FeatureCommandHost } from './feature-contract.ts'
import { featureCurrent, releaseFeatureOwner, rememberFeatureOwner } from './feature-host-ownership.ts'

type ContinueAfterReview = (
  reference: string,
  host: FeatureCommandHost,
  canContinue: () => boolean,
) => Promise<NativeSuccessor | undefined>

export async function deliverEpicFinalReview(
  result: Extract<ContinueFeatureResult, { kind: 'epic-final-review' }>,
  host: FeatureCommandHost,
  continueAfterReview: ContinueAfterReview,
): Promise<void> {
  if (host.prepareEpicRangeReview === undefined) {
    await host.send('feature-stopped: epic-final-review-unprepared')
    return
  }
  const target = `#${result.review.context.number}`
  const owner = { reference: target, cwd: host.cwd, pausable: true }
  rememberFeatureOwner(host.key, owner)
  try {
    await host.prepareEpicRangeReview(result.review, (canContinue) =>
      continueAfterReview(
        target,
        host,
        featureCurrent(host.key, owner, () => canContinue() && !host.featureContinuationInhibited()),
      ),
    )
  } catch (error) {
    releaseFeatureOwner(host.key)
    await host.send(`feature-stopped: ${error instanceof Error ? error.message : 'epic-final-review-unprepared'}`)
  }
}
