import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { hasNativeUserInterruptFlag } from '../dist/contracts.js'
import {
  type FixHost,
  hasOwnedFixRun,
  interruptExactOwnedFixRun,
  interruptOwnedFixRun,
  ownedFixRunFor,
  reviewControllerFor,
} from './omp-controller'
import { joinFeatureInterruption } from './omp-feature-interruption-join.ts'
import type { NativeExtension } from './review-runtime/contracts.ts'
import { type JoinedNativeStop, throwJoinedStopFailures } from './review-runtime/controller-stop.ts'

export function rootContext(ctx: ExtensionContext): boolean {
  return ctx.agent.kind === 'main' && ctx.agent.depth === 0
}

export type FeatureWorkInterrupter = (reason: string) => Promise<JoinedNativeStop>

export function featureWorkInterrupter(pi: NativeExtension): FeatureWorkInterrupter {
  return async (reason: string): Promise<JoinedNativeStop> => {
    const controller = reviewControllerFor(pi)
    controller.inhibitFeatureContinuation()
    const owned = ownedFixRunFor(pi)
    const ingressUnknown = owned === undefined && hasOwnedFixRun(pi)
    const stopping = interruptOwnedFixRun(pi, reason)
    const native = controller.stopJoined(reason)
    return joinFeatureInterruption(
      native,
      owned !== undefined && stopping !== undefined ? { stop: stopping, release: owned.release } : undefined,
      ingressUnknown || (owned !== undefined && stopping === undefined),
    )
  }
}

export function installFeatureSessionLifecycle(
  pi: FixHost,
  interruptOwnedFeatureWork = featureWorkInterrupter(pi),
): void {
  const stopOwnedWork = async (reason: string): Promise<void> => {
    throwJoinedStopFailures(await interruptOwnedFeatureWork(reason))
  }

  pi.on('session_stop', (event, ctx) => {
    if (!rootContext(ctx)) return
    // Ordinary idle settle only: native bridge settle/watchSettleAbort handles batches.
    // Do not treat signal aborts as explicit user interruption.
    if (event.signal.aborted) {
      void interruptOwnedFixRun(pi, 'session-settle-aborted')
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
    return stopOwnedWork('session-stop')
  })
  pi.on('session_switch', (_event, ctx) => {
    if (!rootContext(ctx)) return
    ctx.ui?.setStatus?.('omp-build-watch', undefined)
    void interruptOwnedFixRun(pi, 'session-switched')
    return stopOwnedWork('session-switch')
  })
  pi.on('session_shutdown', (_event, ctx) => {
    if (!rootContext(ctx)) return
    void interruptOwnedFixRun(pi, 'session-shutdown')
    return stopOwnedWork('session-shutdown')
  })
}
