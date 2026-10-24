import type { FeatureSessionReason, FeatureWorkflow } from './feature-contract.ts'
import { abortOwnedFeatureWatch } from './feature-host-watch.ts'
import { pauseUnconfirmed } from './feature-presentation.ts'

type OwnedFeature = {
  reference: string
  cwd: string
  pausable: boolean
}

const ownedFeatures = new WeakMap<object, OwnedFeature>()

export function rememberFeatureOwner(key: object, owned: OwnedFeature): void {
  ownedFeatures.set(key, owned)
}

export function releaseFeatureOwner(key: object): void {
  ownedFeatures.delete(key)
}

export async function pauseOwnedFeatureOnSessionEnd(
  key: object,
  reason: FeatureSessionReason,
  workflow: FeatureWorkflow,
  interrupt: () => Promise<void>,
  report?: (text: string) => Promise<void>,
): Promise<void> {
  const owned = ownedFeatures.get(key)
  abortOwnedFeatureWatch(key)
  try {
    await interrupt()
  } catch {
    // A failed local interrupt does not skip the product pause attempt.
  }
  if (owned === undefined || ownedFeatures.get(key) !== owned || owned.pausable !== true) return
  try {
    const paused = await workflow.requestFeatureSessionPause({
      cwd: owned.cwd,
      reason,
      interrupt,
      reference: owned.reference,
    })
    if (paused.kind === 'paused') {
      await report?.(paused.confirmed === true ? `pause-confirmed: ${paused.reason}` : pauseUnconfirmed(paused.reason))
    }
  } catch (error) {
    await report?.(`feature-stopped: ${error instanceof Error ? error.message : String(error)}`)
  }
}
