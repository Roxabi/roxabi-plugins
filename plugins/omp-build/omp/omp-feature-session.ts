import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { hasNativeUserInterruptFlag } from '../dist/contracts.js'
import { type OmpBuildExtensionApi, reviewControllerFor } from './omp-controller'
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
    return controller.stopJoined(reason)
  }
}

export function installFeatureSessionLifecycle(
  pi: OmpBuildExtensionApi,
  interruptOwnedFeatureWork = featureWorkInterrupter(pi),
): void {
  const stopOwnedWork = async (reason: string): Promise<void> => {
    throwJoinedStopFailures(await interruptOwnedFeatureWork(reason))
  }

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
    return stopOwnedWork('session-switch')
  })
  pi.on('session_shutdown', (_event, ctx) => {
    if (!rootContext(ctx)) return
    return stopOwnedWork('session-shutdown')
  })
}
