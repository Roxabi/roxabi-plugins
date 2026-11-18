import type { NativeBatch } from '../omp/review-runtime/contracts.ts'
import type { FeatureCommandHost } from './feature-contract.ts'
import type { FeatureCurrent } from './feature-host-ownership.ts'

export async function announceOwnedFeature(
  host: FeatureCommandHost,
  followUp: NativeBatch,
  owns: () => boolean,
  current?: FeatureCurrent,
): Promise<void> {
  try {
    host.markFeatureBatch(followUp)
    await host.native.announce(followUp, () => (current?.() ?? true) && owns() && !host.featureContinuationInhibited())
    if (current?.() === false || !owns() || host.featureContinuationInhibited()) {
      await host.native.stopOwned(followUp, 'feature-operation-origin-changed')
      return
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    await host.native.stopOwned(followUp, reason)
    await host.send(`feature-stopped: ${reason}`)
  }
}
