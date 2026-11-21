import type { FixRun } from '../roxabi/fix-entry-lifecycle.ts'
import type { FixExecutionFence } from '../roxabi/fix-execution-fence.ts'
import { type FixHost, ownedFixRunFor, releaseOwnedFixRun } from './omp-controller.ts'

/** Join the originating driver's host work and preserve release uncertainty for its owner. */
export async function finishOwnedFixRun(
  pi: FixHost,
  run: FixRun,
  fence: FixExecutionFence,
  label: string,
): Promise<void> {
  const owned = ownedFixRunFor(pi)
  if (owned?.run !== run) return
  await run.driverTerminated
  if (owned.stopping !== undefined) {
    try {
      await owned.stopping
    } catch {
      fence.markHostUnknown('fix-stop-unconfirmed')
    }
  }
  await fence.closeHostOperations()
  const failures: unknown[] = []
  try {
    const settled = await fence.settleInterruptedOwner()
    if (!settled.ok)
      console.error(`omp-build: interrupted ${label} owner remains held: ${settled.diagnostics.join(', ')}`)
  } catch (error) {
    failures.push(error)
    console.error(
      `omp-build: interrupted ${label} owner remains held: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (fence.destinationLeaseFacts() !== null) {
    try {
      const released = await fence.releaseDestinationLease()
      if (released.status !== 'released') {
        const reason = `omp-build: ${label} destination lease retained: ${released.diagnostics.map((item) => item.code).join(', ')}`
        console.error(reason)
        failures.push(new Error(reason))
      }
    } catch (error) {
      failures.push(error)
    }
  }
  releaseOwnedFixRun(pi, run)
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'Fix host release failed')
}

/** Keep the original promise observable while signal-only callers cannot lose its rejection. */
export function observeFixRelease(release: Promise<void>): void {
  void release.catch((error) => {
    console.error(`omp-build: fix host release failed: ${error instanceof Error ? error.message : String(error)}`)
  })
}
