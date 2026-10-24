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
import { nativeSnapshot, object, relevantSubagentPayload } from './capture'
import { captureChildResult } from './child-capture'
import type { NativeBatchResult, NativeChildResult, NativeExtension } from './contracts'
import type { NativeBatchController } from './controller'
import { followUpAnnouncement } from './port'
import type { ActiveBatch } from './state'

export type ResolvedTaskResult = {
  result: NativeBatchResult
  complete: boolean
  exactCount: boolean
  identitiesMatch: boolean
}

function root(ctx: ExtensionContext): boolean {
  return ctx.agent.kind === 'main' && ctx.agent.depth === 0
}

export function capturedChild(
  active: ActiveBatch,
  value: unknown,
  expectedId: string | null,
  captureId: string | null = null,
): NativeChildResult {
  return captureChildResult(active, value, expectedId, captureId)
}

function terminalIndex(value: unknown, taskCount: number): number | null {
  if (!object(value) || typeof value.index !== 'number') return null
  if (!Number.isInteger(value.index) || value.index < 0 || value.index >= taskCount) return null
  return value.index
}

function terminalAssociations(values: unknown[], taskCount: number) {
  const terminalByTaskIndex = new Map<number, { terminalIndex: number; value: unknown }>()
  const terminalChildIds = new Set<string>()
  let exactAssociation = true
  for (const [resultIndex, value] of values.entries()) {
    const child = object(value) ? value : null
    const childId = child !== null && typeof child.id === 'string' ? child.id : null
    const taskIndex = terminalIndex(value, taskCount)
    if (
      taskIndex === null ||
      terminalByTaskIndex.has(taskIndex) ||
      childId === null ||
      childId.length === 0 ||
      terminalChildIds.has(childId)
    ) {
      exactAssociation = false
      continue
    }
    terminalChildIds.add(childId)
    terminalByTaskIndex.set(taskIndex, { terminalIndex: resultIndex, value })
  }
  return { terminalByTaskIndex, exactAssociation }
}

export function resolveTaskResult(active: ActiveBatch, event: ToolResultEvent): ResolvedTaskResult {
  const values = object(event.details) && Array.isArray(event.details.results) ? event.details.results : []
  const { terminalByTaskIndex, exactAssociation: associatedExactly } = terminalAssociations(
    values,
    active.batch.tasks.tasks.length,
  )
  const consumed = new Set<number>()
  const children: NativeChildResult[] = []
  let exactAssociation = associatedExactly
  for (const [taskIndex, task] of active.batch.tasks.tasks.entries()) {
    const terminal = terminalByTaskIndex.get(taskIndex)
    if (terminal === undefined) {
      children.push(capturedChild(active, null, task.name))
      continue
    }
    consumed.add(terminal.terminalIndex)
    const child = capturedChild(active, terminal.value, task.name)
    const result = object(terminal.value) ? terminal.value : null
    if (child.id === null || result?.agent !== task.agent) exactAssociation = false
    children.push(child)
  }
  for (const [index, value] of values.entries()) {
    if (!consumed.has(index)) children.push(capturedChild(active, value, null))
  }
  const exactCount = values.length === active.batch.tasks.tasks.length
  const identitiesMatch = exactCount && exactAssociation && terminalByTaskIndex.size === active.batch.tasks.tasks.length
  const complete =
    event.isError !== true &&
    exactCount &&
    identitiesMatch &&
    children.length === active.batch.tasks.tasks.length &&
    children.every((child) => child.usable)
  return {
    result: {
      batch: active.batch,
      children,
      raw: nativeSnapshot({
        toolCallId: event.toolCallId,
        isError: event.isError,
        details: event.details,
        content: event.content,
      }),
      complete,
    },
    complete,
    exactCount,
    identitiesMatch,
  }
}

/** Install the public-SDK native task bridge and raw-yield capture. */
export function installNativeBatchBridge(pi: NativeExtension, controller: NativeBatchController): void {
  pi.on('session_start', (_event, ctx) => {
    controller.observeRootContext(ctx)
  })

  pi.events.on('task:subagent:event', (value: unknown) => {
    if (!relevantSubagentPayload(value)) return
    controller.captureSubagentEvent(value)
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

  pi.on('tool_result', async (event: ToolResultEvent, ctx: ExtensionContext) => {
    controller.observeRootContext(ctx)
    if (event.toolName === 'task' && root(ctx)) await controller.receiveResult(event)
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
    if (message !== null) await pi.sendUserMessage(message, { deliverAs: 'followUp' })
  })
}
