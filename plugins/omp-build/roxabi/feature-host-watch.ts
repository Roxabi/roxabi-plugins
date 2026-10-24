import { parseInstalledWatchCommand } from './feature-command.ts'
import type { ContinueFeatureResult, FeatureCommandHost } from './feature-contract.ts'
import { rememberFeatureOwner } from './feature-host-lifetime.ts'

const ownedWatches = new WeakMap<object, AbortController>()

/** Ephemeral only. Pause, abandon, and session end abort the owned watch; nothing is written to disk. */
export function abortOwnedFeatureWatch(key: object): void {
  const controller = ownedWatches.get(key)
  if (controller === undefined) return
  ownedWatches.delete(key)
  controller.abort()
}

export async function startInstalledFeatureWatch(
  reference: string,
  command: string,
  host: FeatureCommandHost,
  deliver: (result: ContinueFeatureResult) => Promise<void>,
): Promise<void> {
  const watch = parseInstalledWatchCommand(command)
  if (watch === null) {
    await host.send('feature-stopped: watch-command-invalid')
    return
  }
  abortOwnedFeatureWatch(host.key)
  const controller = new AbortController()
  ownedWatches.set(host.key, controller)
  rememberFeatureOwner(host.key, { reference, cwd: host.cwd, pausable: true })
  settleInstalledWatch(
    reference,
    host,
    controller,
    host.cwd,
    watch.pr,
    host.exec('bash', watch.args, { cwd: host.cwd, signal: controller.signal }),
    deliver,
  )
  // Idle Esc/RPC while only this host watch runs is not a workflow pause (D2-B).
  await host.send(
    'ci-watch: running. Idle Esc/RPC does not pause or disarm this watch — use /feature pause or /feature abandon; session switch/shutdown still pause.',
  )
}

function settleInstalledWatch(
  reference: string,
  host: FeatureCommandHost,
  controller: AbortController,
  cwd: string,
  pr: number,
  pending: Promise<{ code: number; killed: boolean }>,
  deliver: (result: ContinueFeatureResult) => Promise<void>,
): void {
  void pending.then(
    async (result) => {
      if (ownedWatches.get(host.key) === controller) ownedWatches.delete(host.key)
      if (controller.signal.aborted) return
      if (result.killed || result.code < 0) {
        await host.send('feature-stopped: watch-exit-unobserved')
        return
      }
      if (host.featureContinuationInhibited()) {
        await host.send('feature-stopped: continuation-inhibited')
        return
      }
      try {
        const next = await host.workflow.consumeWatchExit({ cwd, pr, code: result.code, reference })
        await deliver(next)
      } catch (error) {
        await host.send(`feature-stopped: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
    async (error: unknown) => {
      if (ownedWatches.get(host.key) === controller) ownedWatches.delete(host.key)
      if (controller.signal.aborted) return
      await host.send(`feature-stopped: ${error instanceof Error ? error.message : String(error)}`)
    },
  )
}
