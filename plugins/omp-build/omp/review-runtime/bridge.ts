import { isDeepStrictEqual } from 'node:util'
import type {
  AgentEndEvent,
  BeforeSubagentSpawnEvent,
  ExtensionContext,
  SessionShutdownEvent,
  SessionStopEvent,
  SessionSwitchEvent,
  ToolCallEvent,
  ToolResultEvent,
} from '@oh-my-pi/pi-coding-agent'
import { createActionCommunication } from '../action-communication.ts'
import type { NativeExtension } from './contracts'
import type { NativeBatchController } from './controller'
import { installExecutedChildGuard } from './executed-child-guard.ts'
import { followUpAnnouncement } from './port'
import { type OwnedResultReplacement, unusableOwnedReplacement } from './result-replacement.ts'

function root(ctx: ExtensionContext): boolean {
  return ctx.agent.kind === 'main' && ctx.agent.depth === 0
}

/** Install the public-SDK native task bridge and raw-yield capture. */
export function installNativeBatchBridge(pi: NativeExtension, controller: NativeBatchController): void {
  installExecutedChildGuard(pi, controller)
  pi.on('session_start', (_event, ctx) => {
    controller.observeRootContext(ctx)
    if (root(ctx)) controller.bindCommunication(createActionCommunication(pi, ctx))
  })

  pi.on('tool_call', (event: ToolCallEvent, ctx: ExtensionContext) => {
    controller.observeRootContext(ctx)
    if (event.toolName !== 'task' || !root(ctx)) return

    const batch = controller.active()
    if (batch === null) return

    const input = controller.wire(batch)
    if (input === null) return

    if (!isDeepStrictEqual(event.input, input)) {
      return { block: true, reason: 'omp-build has a different host-authorized native task batch' }
    }
    if (!controller.admit(batch, event.toolCallId)) {
      return { block: true, reason: 'native batch became inactive before dispatch' }
    }
  })

  pi.on('before_subagent_spawn', (event: BeforeSubagentSpawnEvent, ctx: ExtensionContext) => {
    controller.observeRootContext(ctx)
    if (!root(ctx)) return

    const reason = controller.allowSpawn(event)
    return reason === null ? undefined : { block: true, reason }
  })

  pi.on('tool_result', (event: ToolResultEvent, ctx: ExtensionContext) => {
    controller.observeRootContext(ctx)
    if (root(ctx)) controller.bindCommunication(createActionCommunication(pi, ctx))
    if (event.toolName !== 'task' || !root(ctx) || !controller.ownsTaskResult(event.toolCallId)) return
    let replacement: OwnedResultReplacement
    try {
      replacement =
        controller.prepareOwnedResultReplacement(event, ctx) ?? unusableOwnedReplacement('result-replacement-failed')
    } catch {
      replacement = unusableOwnedReplacement('result-replacement-failed')
    }
    if (replacement.details.detailRef === 'retention-unavailable') {
      controller.noteRetentionFailure(event.toolCallId, replacement.details.summary)
    }
    controller.queueOwnedSettlement(event)
    return replacement
  })

  pi.on('session_stop', async (event: SessionStopEvent, ctx: ExtensionContext) => {
    controller.observeRootContext(ctx)
    if (!root(ctx)) return

    if (event.signal.aborted) {
      await controller.stop('session-settle-aborted')
      return
    }
    controller.watchSettleAbort(event.signal)
    await controller.settle()
  })

  pi.on('session_switch', async (_event: SessionSwitchEvent, ctx: ExtensionContext) => {
    controller.observeRootContext(ctx)
    if (root(ctx)) await controller.stop('session-switched')
  })

  pi.on('session_shutdown', async (_event: SessionShutdownEvent, ctx: ExtensionContext) => {
    controller.observeRootContext(ctx)
    if (root(ctx)) await controller.stop('session-shutdown')
  })

  pi.on('agent_end', async (event: AgentEndEvent, ctx: ExtensionContext) => {
    controller.observeRootContext(ctx)
    if (!root(ctx) || event.willContinue) return

    const message = followUpAnnouncement(controller)
    if (message !== null) await pi.sendMessage(message, { triggerTurn: true })
  })
}
