import { isDeepStrictEqual } from 'node:util'
import type { ExtensionContext, SubagentEventPayload, ToolCallEvent, ToolResultEvent } from '@oh-my-pi/pi-coding-agent'
import { matchesAuthorizedModel } from './authorized-model-route.ts'
import { json, nativeSnapshot, object } from './capture.ts'
import type { NativeBatch, NativeExtension } from './contracts.ts'
import type { NativeBatchController } from './controller.ts'
import { bindExecutedChild, childExecutionCurrent, observeChildLifecycle } from './executed-child-lifecycle.ts'
import {
  effectiveTools,
  isCanonicalChild,
  loadPinnedProfile,
  toolSetValid,
  validateChildInit,
  validContext,
} from './executed-child-profile.ts'

type Binding = {
  controller: NativeBatchController
  batch: NativeBatch
  id: string
  sessionId: string
  sessionFile: string
  parentId: string
  tools: readonly string[]
  model: { provider: string; id: string }
  task: string
  prompt: string[]
  admitted: boolean
  contextReady: boolean
  providerReady: boolean
  calls: Map<string, { name: string; input: unknown }>
}

function sessionId(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionId()
}

function readyIdentity(binding: Binding, ctx: ExtensionContext, pi: NativeExtension): boolean {
  const guard = binding.controller.executedChild(binding.batch, binding.id, binding.sessionId)
  return (
    guard?.valid === true &&
    childExecutionCurrent(binding.controller, binding.batch, binding.id, binding.sessionFile, binding.parentId) &&
    ctx.agent.kind === 'sub' &&
    ctx.agent.id === binding.id &&
    ctx.agent.parentId === binding.parentId &&
    sessionId(ctx) === binding.sessionId &&
    ctx.sessionManager.getSessionFile() === binding.sessionFile &&
    matchesAuthorizedModel(ctx, binding.model) &&
    toolSetValid(pi, binding.tools)
  )
}

function live(binding: Binding, ctx: ExtensionContext, pi: NativeExtension): boolean {
  return readyIdentity(binding, ctx, pi) && isDeepStrictEqual(ctx.getSystemPrompt(), binding.prompt)
}

function invalidate(binding: Binding | null): void {
  if (!binding) return
  const guard = binding.controller.executedChild(binding.batch, binding.id, binding.sessionId)
  if (guard) guard.valid = false
  binding.contextReady = false
  binding.providerReady = false
}

async function prepareBinding(ctx: ExtensionContext, pi: NativeExtension): Promise<Binding | null> {
  if (ctx.agent.kind !== 'sub' || ctx.agent.depth !== 1 || !ctx.agent.parentId) return null
  const sid = sessionId(ctx)
  const file = ctx.sessionManager.getSessionFile()
  if (!file) return null
  const bound = bindExecutedChild(ctx.agent.id, sid, file, ctx.agent.parentId)
  if (!bound) return null
  const controller = bound.controller
  const task = bound.batch.tasks.tasks[bound.index]
  if (!task || ctx.agent.name.toLowerCase() !== task.agent.toLowerCase()) return null
  const entries = ctx.sessionManager.getEntries().filter((entry) => entry.type === 'session_init')
  if (entries.length !== 1) return null
  const entry = entries[0]
  const profile = await loadPinnedProfile(task)
  if (!profile || !validateChildInit(profile, task, entry) || !entry || typeof entry.task !== 'string') return null
  if (!matchesAuthorizedModel(ctx, bound.model)) return null
  if (!childExecutionCurrent(controller, bound.batch, ctx.agent.id, file, ctx.agent.parentId)) return null
  const tools = effectiveTools(pi, profile)
  if (!tools) return null
  return {
    controller,
    batch: bound.batch,
    id: ctx.agent.id,
    sessionId: sid,
    sessionFile: file,
    parentId: ctx.agent.parentId,
    tools,
    model: bound.model,
    task: entry.task,
    prompt: [
      profile.prompt,
      `Shared task context:\n${bound.batch.tasks.context}`,
      `Submit the result by calling yield with a data value conforming to this JSON schema:\n${JSON.stringify(profile.outputSchema)}`,
    ],
    admitted: false,
    contextReady: false,
    providerReady: false,
    calls: new Map(),
  }
}

function allowedCall(binding: Binding, event: ToolCallEvent, ctx: ExtensionContext, pi: NativeExtension): boolean {
  return live(binding, ctx, pi) && binding.tools.includes(event.toolName) && !binding.calls.has(event.toolCallId)
}

function recordYield(binding: Binding, event: ToolResultEvent, input: unknown): boolean {
  if (event.toolName !== 'yield') return true
  const data = object(input) ? input.data : undefined
  if (event.isError || !json(data)) return false
  const guard = binding.controller.executedChild(binding.batch, binding.id, binding.sessionId)
  if (guard) guard.yieldData = data
  return true
}

function activateBinding(binding: Binding, ctx: ExtensionContext, pi: NativeExtension): void {
  if (!toolSetValid(pi, binding.tools) || !matchesAuthorizedModel(ctx, binding.model)) return
  if (!childExecutionCurrent(binding.controller, binding.batch, binding.id, binding.sessionFile, binding.parentId))
    return
  if (ctx.sessionManager.getSessionFile() !== binding.sessionFile || sessionId(ctx) !== binding.sessionId) return
  const guard = binding.controller.executedChild(binding.batch, binding.id, binding.sessionId)
  if (guard) guard.valid = true
}

/** Only the root's SDK lifecycle bus records starts for its admitted batch. */
export function installExecutedChildGuard(pi: NativeExtension, controller: NativeBatchController): void {
  let binding: Binding | null = null
  let ownedChild = false
  const unsubscribe = pi.events.on('task:subagent:lifecycle', (event) => observeChildLifecycle(controller, event))
  pi.on('session_start', async (_event, ctx) => {
    if (!isCanonicalChild(ctx)) return
    ownedChild = true
    try {
      const prepared = await prepareBinding(ctx, pi)
      if (!prepared) return
      binding = prepared
      await pi.setActiveTools([...binding.tools])
      activateBinding(binding, ctx, pi)
    } catch {
      invalidate(binding)
    }
  })
  pi.on('before_agent_start', (event, ctx) => {
    if (!isCanonicalChild(ctx)) return
    try {
      if (binding && readyIdentity(binding, ctx, pi) && (binding.admitted || event.prompt === binding.task)) {
        binding.contextReady = false
        binding.providerReady = false
        return { systemPrompt: binding.prompt }
      }
    } catch {
      // The SDK swallows handler exceptions, so failure must explicitly abort.
    }
    ctx.abort()
    invalidate(binding)
  })
  pi.on('context', (event, ctx) => {
    if (!isCanonicalChild(ctx)) return
    if (!binding) return ctx.abort()
    binding.contextReady = false
    binding.providerReady = false
    try {
      if (!live(binding, ctx, pi) || !validContext(event.messages, binding.task, binding.admitted)) {
        invalidate(binding)
        return ctx.abort()
      }
      binding.contextReady = true
    } catch {
      invalidate(binding)
      ctx.abort()
    }
  })
  pi.on('before_provider_request', (event, ctx) => {
    if (!isCanonicalChild(ctx)) return
    if (!binding) return ctx.abort()
    binding.providerReady = false
    try {
      if (!binding.contextReady || !live(binding, ctx, pi) || !object(event.payload)) {
        invalidate(binding)
        return ctx.abort()
      }
      binding.contextReady = false
      binding.admitted = true
      binding.providerReady = true
    } catch {
      invalidate(binding)
      ctx.abort()
    }
  })
  pi.on('message_start', (event, ctx) => {
    if (binding && live(binding, ctx, pi)) {
      binding.controller.captureExecutedChild(binding.batch, binding.id, binding.sessionId, event)
    }
  })
  pi.on('message_update', (event, ctx) => {
    if (binding && live(binding, ctx, pi)) {
      binding.controller.captureExecutedChild(binding.batch, binding.id, binding.sessionId, event)
    }
  })
  pi.on('message_end', (event, ctx) => {
    if (binding && live(binding, ctx, pi)) {
      binding.controller.captureExecutedChild(binding.batch, binding.id, binding.sessionId, event)
    }
  })
  pi.on('tool_call', (event: ToolCallEvent, ctx) => {
    if (!isCanonicalChild(ctx)) return
    try {
      if (!binding?.providerReady || !allowedCall(binding, event, ctx, pi)) {
        invalidate(binding)
        return { block: true, reason: 'native executed-child guard refused tool call' }
      }
      const input = nativeSnapshot(event.input)
      if (input === null) {
        invalidate(binding)
        return { block: true, reason: 'native child tool input unavailable' }
      }
      binding.calls.set(event.toolCallId, { name: event.toolName, input })
      const captured = {
        type: 'tool_execution_start',
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        args: input,
      } as SubagentEventPayload['event']
      binding.controller.captureExecutedChild(binding.batch, binding.id, binding.sessionId, captured)
    } catch {
      invalidate(binding)
      return { block: true, reason: 'native executed-child guard failed' }
    }
  })
  pi.on('tool_result', (event: ToolResultEvent, ctx) => {
    if (!ownedChild || !binding) return
    try {
      const call = binding.calls.get(event.toolCallId)
      binding.calls.delete(event.toolCallId)
      if (
        !call ||
        call.name !== event.toolName ||
        !isDeepStrictEqual(call.input, nativeSnapshot(event.input)) ||
        !live(binding, ctx, pi)
      )
        return invalidate(binding)
      if (!recordYield(binding, event, call.input)) return invalidate(binding)
      const captured = {
        type: 'tool_execution_end',
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        result: { content: event.content, details: event.details },
        isError: event.isError,
      } as SubagentEventPayload['event']
      binding.controller.captureExecutedChild(binding.batch, binding.id, binding.sessionId, captured)
    } catch {
      invalidate(binding)
    }
  })
  pi.on('session_switch', (_event, ctx) => {
    if (ctx.agent.kind !== 'main') invalidate(binding)
  })
  pi.on('session_shutdown', (_event, ctx) => {
    if (ctx.agent.kind === 'main') {
      unsubscribe()
    } else if (binding) {
      const guard = binding.controller.executedChild(binding.batch, binding.id, binding.sessionId)
      if (
        !guard ||
        guard.yieldData === null ||
        binding.calls.size !== 0 ||
        !childExecutionCurrent(
          binding.controller,
          binding.batch,
          binding.id,
          binding.sessionFile,
          binding.parentId,
          true,
        ) ||
        ctx.agent.id !== binding.id ||
        ctx.agent.parentId !== binding.parentId ||
        sessionId(ctx) !== binding.sessionId ||
        ctx.sessionManager.getSessionFile() !== binding.sessionFile ||
        !isDeepStrictEqual(ctx.getSystemPrompt(), binding.prompt) ||
        !matchesAuthorizedModel(ctx, binding.model) ||
        !toolSetValid(pi, binding.tools)
      )
        invalidate(binding)
      binding = null
    }
  })
}
