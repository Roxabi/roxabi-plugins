import { parseInstalledWatchCommand } from './feature-command.ts'
import type { ContinueFeatureResult, FeatureCommandHost } from './feature-contract.ts'
import { rememberFeatureOwner, settleOwnedFeatureWatch, startOwnedFeatureWatch } from './feature-host-ownership.ts'

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
  const controller = startOwnedFeatureWatch(host.key)
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
      settleOwnedFeatureWatch(host.key, controller)
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
      settleOwnedFeatureWatch(host.key, controller)
      if (controller.signal.aborted) return
      await host.send(`feature-stopped: ${error instanceof Error ? error.message : String(error)}`)
    },
  )
}
