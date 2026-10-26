import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { hasNativeUserInterruptFlag } from '../dist/contracts.js'
import type { FeatureSessionReason, FeatureWorkflow } from '../roxabi/feature-contract.ts'
import { pauseOwnedFeatureOnSessionEnd } from '../roxabi/feature-host-lifetime.ts'
import { abortOwnedFeatureWatch, ownedFeatureFor } from '../roxabi/feature-host-ownership.ts'
import { loadFeatureWorkflow } from '../roxabi/feature-loader.ts'
import { INSTALL_ROOT, installRootStatus, replacedInstallRootMessage } from './install-root'
import {
  type FixHost,
  interruptExactOwnedFixRun,
  interruptOwnedFixRun,
  ownedFixRunFor,
  reportFeatureTerminalStatus,
  reviewControllerFor,
} from './omp-controller'
import type { NativeExtension } from './review-runtime/contracts.ts'

export type FeatureSessionOptions = { featureWorkflow?: FeatureWorkflow; installRoot?: string }

export function rootContext(ctx: ExtensionContext): boolean {
  return ctx.agent.kind === 'main' && ctx.agent.depth === 0
}

export function featureWorkInterrupter(pi: NativeExtension): (reason: string) => Promise<void> {
  return async (reason: string): Promise<void> => {
    abortOwnedFeatureWatch(pi)
    const controller = reviewControllerFor(pi)
    controller.inhibitFeatureContinuation()
    interruptOwnedFixRun(pi, reason)
    const active = controller.active()
    if (active) await controller.stopOwned(active, reason)
  }
}
async function loadFeatureWorkflowForSessionEnd(
  pi: FixHost,
  options: FeatureSessionOptions,
): Promise<FeatureWorkflow | null> {
  if (ownedFeatureFor(pi)?.pausable !== true) return null
  const install = installRootStatus(options.installRoot ?? INSTALL_ROOT)
  if (!install.present) {
    reportFeatureTerminalStatus(pi, `feature-stopped: ${replacedInstallRootMessage(install.root, install.version)}`)
    return null
  }
  return (
    options.featureWorkflow ??
    (await loadFeatureWorkflow().catch(() => {
      reportFeatureTerminalStatus(pi, 'feature-stopped: feature-workflow-unavailable')
      return null
    }))
  )
}

export function installFeatureSessionLifecycle(
  pi: FixHost,
  options: FeatureSessionOptions,
  interruptOwnedFeatureWork = featureWorkInterrupter(pi),
): void {
  const pauseFeatureOnSessionEnd = (reason: FeatureSessionReason): Promise<void> => {
    const local = interruptOwnedFeatureWork(reason)
    return (async () => {
      const workflow = await loadFeatureWorkflowForSessionEnd(pi, options)
      if (workflow === null) {
        await local
        return
      }
      try {
        await pauseOwnedFeatureOnSessionEnd(
          pi,
          reason,
          workflow,
          () => local,
          async (text) => {
            reportFeatureTerminalStatus(pi, text)
          },
        )
      } catch (error) {
        reportFeatureTerminalStatus(pi, `feature-stopped: ${error instanceof Error ? error.message : String(error)}`)
      }
    })()
  }

  pi.on('session_stop', (event, ctx) => {
    if (!rootContext(ctx)) return
    // Ordinary idle settle only: native bridge settle/watchSettleAbort handles batches.
    // Do not product-pause or abort CI watch here (D2-B). Do not treat signal aborts as §85.
    if (event.signal.aborted) {
      interruptOwnedFixRun(pi, 'session-settle-aborted')
      return
    }
    const owned = ownedFixRunFor(pi)
    if (owned !== undefined) {
      event.signal.addEventListener('abort', () => interruptExactOwnedFixRun(pi, owned, 'session-settle-aborted'), {
        once: true,
      })
    }
  })
  pi.on('message_end', (event, ctx) => {
    if (!rootContext(ctx)) return
    const message = event.message
    if (
      !message ||
      typeof message !== 'object' ||
      !('role' in message) ||
      message.role !== 'assistant' ||
      !('stopReason' in message) ||
      message.stopReason !== 'aborted' ||
      !('errorId' in message) ||
      !hasNativeUserInterruptFlag(typeof message.errorId === 'number' ? message.errorId : undefined)
    ) {
      return
    }
    return pauseFeatureOnSessionEnd('session-stop')
  })
  pi.on('session_switch', (_event, ctx) => {
    if (!rootContext(ctx)) return
    interruptOwnedFixRun(pi, 'session-switched')
    return pauseFeatureOnSessionEnd('session-switch')
  })
  pi.on('session_shutdown', (_event, ctx) => {
    if (!rootContext(ctx)) return
    interruptOwnedFixRun(pi, 'session-shutdown')
    return pauseFeatureOnSessionEnd('session-shutdown')
  })
}
