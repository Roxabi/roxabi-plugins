import type { FeatureSessionReason, FeatureWorkflow } from './feature-contract.ts'
import { abortOwnedFeatureWatch, ownedFeatureFor } from './feature-host-ownership.ts'
import { pauseUnconfirmed } from './feature-presentation.ts'

export async function pauseOwnedFeatureOnSessionEnd(
  key: object,
  reason: FeatureSessionReason,
  workflow: FeatureWorkflow,
  interrupt: () => Promise<void>,
  report?: (text: string) => Promise<void>,
): Promise<void> {
  const owned = ownedFeatureFor(key)
  abortOwnedFeatureWatch(key)
  try {
    await interrupt()
  } catch {
    // A failed local interrupt does not skip the product pause attempt.
  }
  if (owned === undefined || ownedFeatureFor(key) !== owned || owned.pausable !== true) return
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
