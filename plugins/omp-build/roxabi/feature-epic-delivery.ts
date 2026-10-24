import type { ContinueFeatureResult, FeatureCommandHost } from './feature-contract.ts'
import { releaseFeatureOwner, rememberFeatureOwner } from './feature-host-ownership.ts'

type ContinueAfterReview = (reference: string, host: FeatureCommandHost) => Promise<void>

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
  rememberFeatureOwner(host.key, { reference: target, cwd: host.cwd, pausable: true })
  try {
    await host.prepareEpicRangeReview(result.review, () => continueAfterReview(target, host))
  } catch (error) {
    releaseFeatureOwner(host.key)
    await host.send(`feature-stopped: ${error instanceof Error ? error.message : 'epic-final-review-unprepared'}`)
  }
}
