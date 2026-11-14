import { parseInstalledWatchCommand } from './feature-command.ts'
import type { ContinueFeatureResult, FeatureCommandHost } from './feature-contract.ts'
import {
  isOwnedFeatureWatch,
  type OwnedFeature,
  ownedFeatureFor,
  rememberFeatureOwner,
  settleOwnedFeatureWatch,
  startOwnedFeatureWatch,
} from './feature-host-ownership.ts'

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
  const owner = { reference, cwd: host.cwd, pausable: true }
  controller.signal.addEventListener(
    'abort',
    () => {
      if (ownedFeatureFor(host.key) === owner) host.status(undefined)
    },
    { once: true },
  )
  rememberFeatureOwner(host.key, owner)
  settleInstalledWatch(
    reference,
    host,
    controller,
    owner,
    host.cwd,
    watch.pr,
    host.exec('bash', watch.args, { cwd: host.cwd, signal: controller.signal }),
    deliver,
  )
  // Idle Esc/RPC while only this host watch runs is not a workflow pause (D2-B).
  host.status(
    `ci-watch: running · UW ${reference} · PR #${watch.pr} · host CI watch (no agent) · next: observe checks. Idle Esc/RPC does not pause or disarm this watch — use /feature pause or /feature abandon; session switch/shutdown still pause.`,
  )
}

function settleInstalledWatch(
  reference: string,
  host: FeatureCommandHost,
  controller: AbortController,
  owner: OwnedFeature,
  cwd: string,
  pr: number,
  pending: Promise<{ code: number; killed: boolean }>,
  deliver: (result: ContinueFeatureResult) => Promise<void>,
): void {
  void pending.then(
    async (result) => {
      if (!isOwnedFeatureWatch(host.key, controller) || ownedFeatureFor(host.key) !== owner) return
      if (result.killed || result.code < 0) {
        host.status(undefined)
        settleOwnedFeatureWatch(host.key, controller)
        await host.send('feature-stopped: watch-exit-unobserved')
        return
      }
      if (host.featureContinuationInhibited()) {
        host.status(undefined)
        settleOwnedFeatureWatch(host.key, controller)
        await host.send('feature-stopped: continuation-inhibited')
        return
      }
      host.status(
        `ci-watch: finished · UW ${reference} · PR #${pr} · host continuation (no agent) · next: assess checks and landing`,
      )
      await deliverWatchExit(reference, host, controller, owner, cwd, pr, result.code, deliver)
    },
    async (error: unknown) => {
      if (!settleOwnedFeatureWatch(host.key, controller) || ownedFeatureFor(host.key) !== owner) return
      host.status(undefined)
      await host.send(`feature-stopped: ${error instanceof Error ? error.message : String(error)}`)
    },
  )
}

async function deliverWatchExit(
  reference: string,
  host: FeatureCommandHost,
  controller: AbortController,
  owner: OwnedFeature,
  cwd: string,
  pr: number,
  code: number,
  deliver: (result: ContinueFeatureResult) => Promise<void>,
): Promise<void> {
  try {
    const next = await host.workflow.consumeWatchExit({
      cwd,
      pr,
      code,
      reference,
      ...(host.uw === undefined ? {} : { uw: host.uw }),
    })
    if (!settleOwnedFeatureWatch(host.key, controller) || ownedFeatureFor(host.key) !== owner) return
    await deliver(next)
  } catch (error) {
    if (controller.signal.aborted || ownedFeatureFor(host.key) !== owner) return
    host.status(undefined)
    settleOwnedFeatureWatch(host.key, controller)
    await host.send(`feature-stopped: ${error instanceof Error ? error.message : String(error)}`)
  }
}
