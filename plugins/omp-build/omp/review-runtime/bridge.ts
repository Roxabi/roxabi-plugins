import type {
  AgentEndEvent,
  BeforeSubagentSpawnEvent,
  ExtensionContext,
  SessionShutdownEvent,
  SessionStopEvent,
  SessionSwitchEvent,
} from '@oh-my-pi/pi-coding-agent'
import { createActionCommunication } from '../action-communication.ts'
import { executeOwnedBatch } from './batch-execution.ts'
import type { NativeExtension } from './contracts'
import type { NativeBatchController } from './controller'
import { installExecutedChildGuard } from './executed-child-guard.ts'
import { followUpAnnouncement, markNativeTurnEnded, resetNativeTurn } from './port'
import { releaseTaskMask, taskMaskCurrent, taskMaskOwnsActiveBatch } from './task-mask-lease'

function root(ctx: ExtensionContext): boolean {
  return ctx.agent.kind === 'main' && ctx.agent.depth === 0
}

/** Install the owned native dispatch and real child guard. */
export function installNativeBatchBridge(pi: NativeExtension, controller: NativeBatchController): void {
  pi.registerTool({
    name: 'omp_build_execute_native_batch',
    loadMode: 'essential',
    label: 'Execute authorized native batch',
    description: 'Execute the single announced, host-authorized native batch.',
    parameters: {
      type: 'object',
      properties: { batchId: { type: 'string' } },
      required: ['batchId'],
      additionalProperties: false,
    },
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      return executeOwnedBatch(pi, controller, toolCallId, params, signal, ctx)
    },
  })
  installExecutedChildGuard(pi, controller)
  pi.on('session_start', (_event, ctx) => {
    controller.observeRootContext(ctx)
    if (root(ctx)) {
      resetNativeTurn(controller)
      controller.bindCommunication(createActionCommunication(pi, ctx))
    }
  })

  pi.on('agent_start', (_event, ctx) => {
    if (root(ctx)) resetNativeTurn(controller)
  })

  pi.on('tool_call', async (event, ctx) => {
    controller.observeRootContext(ctx)
    const batch = controller.active()
    if (!root(ctx) || !batch || !taskMaskOwnsActiveBatch(controller)) return
    if (!(await taskMaskCurrent(controller, batch))) {
      controller.status('native task mask drifted; stopping owned batch')
      void controller.stopOwned(batch, 'native-task-mask-drifted').catch((error) => {
        controller.status(`native task mask stop failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      if (event.toolName === 'task' || event.toolName === 'omp_build_execute_native_batch') {
        return { block: true, reason: 'native task mask drifted; owned batch stopped' }
      }
    }
  })

  pi.on('before_subagent_spawn', (event: BeforeSubagentSpawnEvent, ctx: ExtensionContext) => {
    controller.observeRootContext(ctx)
    if (!root(ctx)) return

    const reason = controller.allowSpawn(event)
    return reason === null ? undefined : { block: true, reason }
  })

  pi.on('tool_result', (_event, ctx) => {
    controller.observeRootContext(ctx)
    if (root(ctx)) controller.bindCommunication(createActionCommunication(pi, ctx))
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

  pi.on('session_before_switch', async (_event, ctx) => {
    controller.observeRootContext(ctx)
    if (!root(ctx)) return
    try {
      await releaseTaskMask(controller, true)
    } catch (error) {
      controller.status(
        `native task mask restoration failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    await controller.stop('session-switching')
  })

  pi.on('session_switch', async (_event: SessionSwitchEvent, ctx: ExtensionContext) => {
    controller.observeRootContext(ctx)
    if (root(ctx)) {
      resetNativeTurn(controller)
      await controller.stop('session-switched')
    }
  })

  pi.on('session_shutdown', async (_event: SessionShutdownEvent, ctx: ExtensionContext) => {
    controller.observeRootContext(ctx)
    if (root(ctx)) {
      resetNativeTurn(controller)
      await controller.stop('session-shutdown')
    }
  })

  pi.on('agent_end', async (event: AgentEndEvent, ctx: ExtensionContext) => {
    controller.observeRootContext(ctx)
    if (!root(ctx) || (event.willContinue && taskMaskOwnsActiveBatch(controller))) return

    try {
      await releaseTaskMask(controller)
    } catch (error) {
      const reason = `native task mask restoration failed: ${error instanceof Error ? error.message : String(error)}`
      controller.status(reason)
      await controller.stop(reason)
      return
    }
    if (event.willContinue) return
    markNativeTurnEnded(controller)
    await followUpAnnouncement(pi, controller)
  })
}
