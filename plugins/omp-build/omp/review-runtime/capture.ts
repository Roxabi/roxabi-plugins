import type { SubagentEventPayload } from '@oh-my-pi/pi-coding-agent'
import { bashInput, effectiveBashCwd, rememberBashCall } from './bash-call.ts'
import type { Json, NativeProofDirective } from './contracts'
import type { ActiveBatch, ChildCapture, YieldRaw } from './state'

type ToolExecutionStart = Extract<SubagentEventPayload['event'], { type: 'tool_execution_start' }>
export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
export function json(value: unknown): value is Json {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return true
  }
  if (Array.isArray(value)) return value.every(json)
  return object(value) && Object.values(value).every(json)
}
/** Snapshot public SDK values through ordinary JSON wire semantics: omit undefined object fields. */
export function nativeSnapshot(value: unknown): Json | null {
  try {
    const wire = JSON.stringify(value)
    if (wire === undefined) return null
    const snapshot: unknown = JSON.parse(wire)
    return json(snapshot) ? snapshot : null
  } catch {
    return null
  }
}
export function relevantSubagentPayload(value: unknown): value is SubagentEventPayload {
  if (!object(value) || typeof value.id !== 'string' || !object(value.event)) return false
  if (typeof value.event.type !== 'string') return false

  const event = value.event
  if (event.type === 'message_start' || event.type === 'message_end') return true
  if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
    return typeof event.toolName === 'string' && typeof event.toolCallId === 'string'
  }
  if (event.type !== 'message_update' || !object(event.assistantMessageEvent)) return false
  if (typeof event.assistantMessageEvent.type !== 'string') return false

  const assistant = event.assistantMessageEvent
  if (assistant.type === 'text_delta') return typeof assistant.delta === 'string'
  if (assistant.type === 'toolcall_delta') {
    return typeof assistant.contentIndex === 'number' && typeof assistant.delta === 'string'
  }
  return (
    assistant.type === 'toolcall_end' &&
    typeof assistant.contentIndex === 'number' &&
    object(assistant.toolCall) &&
    typeof assistant.toolCall.id === 'string' &&
    typeof assistant.toolCall.name === 'string'
  )
}
function captureFor(active: ActiveBatch, childId: string): ChildCapture {
  let capture = active.captures.get(childId)
  if (capture) return capture

  capture = {
    deltasByContentIndex: new Map(),
    textDeltas: [],
    pendingCalls: new Map(),
    pendingProofCalls: new Map(),
    completedProofCalls: new Map(),
    ambiguousProofCallIds: new Set(),
    pendingBashCalls: new Map(),
    completedBashCalls: new Map(),
    conflictingBashCalls: [],
    ambiguousBashCallIds: new Set(),
    submissions: [],
    partialText: null,
    hostGit: new Map(),
  }
  active.captures.set(childId, capture)
  const slot = active.childSlots.get(childId)
  const name = slot === undefined ? undefined : active.batch.tasks.tasks[slot]?.name
  if (name !== undefined && name !== childId) active.captures.set(name, capture)
  return capture
}
function assistantText(value: unknown): string | null {
  if (!object(value) || value.role !== 'assistant' || !Array.isArray(value.content)) return null
  const text = value.content
    .reduce<string[]>((parts, part) => {
      if (object(part) && part.type === 'text' && typeof part.text === 'string') parts.push(part.text)
      return parts
    }, [])
    .join('')
  return text.length === 0 ? null : text
}
function rawYieldCall(
  toolCallId: string,
  contentIndex: number | null,
  argumentDeltas: readonly string[],
  toolCall: unknown,
): YieldRaw {
  const call = object(toolCall) ? toolCall : null
  return {
    toolCallId,
    contentIndex,
    argumentDeltas: [...argumentDeltas],
    argumentText: argumentDeltas.join(''),
    rawBlock: call !== null && typeof call.rawBlock === 'string' ? call.rawBlock : null,
    toolCallArguments: call !== null ? nativeSnapshot(call.arguments) : null,
    executionArguments: null,
  }
}
function yieldedData(args: unknown): Json | null {
  return object(args) && 'data' in args && json(args.data) ? args.data : null
}
function taskForChild(active: ActiveBatch, childId: string) {
  return (
    active.batch.tasks.tasks.find((task) => task.name === childId) ??
    active.batch.tasks.tasks[active.childSlots.get(childId) ?? -1]
  )
}
function proofDirective(active: ActiveBatch, childId: string): NativeProofDirective | null {
  return taskForChild(active, childId)?.proofEvidence ?? null
}
function captureMessageUpdate(
  capture: ChildCapture,
  assistant: Extract<SubagentEventPayload['event'], { type: 'message_update' }>['assistantMessageEvent'],
): void {
  if (assistant.type === 'text_delta') {
    capture.textDeltas.push(assistant.delta)
    capture.partialText = capture.textDeltas.join('')
    for (const submission of capture.submissions) submission.partialText = capture.partialText
    return
  }
  if (assistant.type === 'toolcall_delta') {
    const deltas = capture.deltasByContentIndex.get(assistant.contentIndex) ?? []
    deltas.push(assistant.delta)
    capture.deltasByContentIndex.set(assistant.contentIndex, deltas)
    return
  }
  if (assistant.type !== 'toolcall_end' || assistant.toolCall.name !== 'yield') return
  const { contentIndex, toolCall } = assistant
  capture.pendingCalls.set(
    toolCall.id,
    rawYieldCall(toolCall.id, contentIndex, capture.deltasByContentIndex.get(contentIndex) ?? [], toolCall),
  )
}
function captureYieldExecution(capture: ChildCapture, event: ToolExecutionStart): void {
  const pending = capture.pendingCalls.get(event.toolCallId)
  const raw = pending ?? rawYieldCall(event.toolCallId, null, [], null)
  raw.executionArguments = nativeSnapshot(event.args)
  capture.pendingCalls.delete(event.toolCallId)
  capture.submissions.push({
    attemptIndex: capture.submissions.length,
    data: yieldedData(event.args),
    raw,
    partialText: capture.partialText,
  })
}
function captureStartedToolExecution(
  active: ActiveBatch,
  capture: ChildCapture,
  childId: string,
  _featureBatch: boolean,
  event: Extract<SubagentEventPayload['event'], { type: 'tool_execution_start' }>,
): void {
  if (event.toolName === 'yield') {
    captureYieldExecution(capture, event)
    return
  }
  if (event.toolName !== 'bash' || !bashInput(event.args)) return
  const input = nativeSnapshot(event.args)
  if (input === null) return
  const pending = { input, effectiveCwd: effectiveBashCwd(event.args, active.defaultCwd) }
  capture.hostGit.set(event.toolCallId, {
    start: pending.effectiveCwd === null ? null : active.observeHostGit(pending.effectiveCwd),
    end: null,
  })
  if (proofDirective(active, childId) !== null) capture.pendingProofCalls.set(event.toolCallId, pending)
  capture.pendingBashCalls.set(event.toolCallId, pending)
}
function captureCompletedBashExecution(
  active: ActiveBatch,
  capture: ChildCapture,
  event: Extract<SubagentEventPayload['event'], { type: 'tool_execution_end' }>,
): void {
  const proofPending = capture.pendingProofCalls.get(event.toolCallId)
  if (proofPending !== undefined) {
    capture.pendingProofCalls.delete(event.toolCallId)
    rememberBashCall(capture.completedProofCalls, capture.ambiguousProofCallIds, event.toolCallId, proofPending, event)
  }
  const bashPending = capture.pendingBashCalls.get(event.toolCallId)
  if (bashPending !== undefined) {
    capture.pendingBashCalls.delete(event.toolCallId)
    const span = capture.hostGit.get(event.toolCallId) ?? { start: null, end: null }
    span.end = bashPending.effectiveCwd === null ? null : active.observeHostGit(bashPending.effectiveCwd)
    capture.hostGit.set(event.toolCallId, span)
    rememberBashCall(
      capture.completedBashCalls,
      capture.ambiguousBashCallIds,
      event.toolCallId,
      bashPending,
      event,
      capture.conflictingBashCalls,
    )
  }
}
function captureToolExecution(
  active: ActiveBatch,
  capture: ChildCapture,
  childId: string,
  featureBatch: boolean,
  event: SubagentEventPayload['event'],
): void {
  if (event.type === 'tool_execution_start') {
    captureStartedToolExecution(active, capture, childId, featureBatch, event)
    return
  }
  if (event.type === 'tool_execution_end' && event.toolName === 'bash')
    captureCompletedBashExecution(active, capture, event)
}
function captureMessageEnd(capture: ChildCapture, message: unknown): void {
  const text = assistantText(message)
  if (text !== null) {
    capture.partialText = text
    for (const submission of capture.submissions) submission.partialText = text
  }
  capture.deltasByContentIndex.clear()
}

export function captureSubagentEvent(active: ActiveBatch, payload: SubagentEventPayload, featureBatch: boolean): void {
  const event = payload.event
  const capture = captureFor(active, payload.id)
  if (event.type === 'message_start') {
    if (object(event.message) && event.message.role === 'assistant') capture.deltasByContentIndex.clear()
    return
  }
  if (event.type === 'message_update') {
    captureMessageUpdate(capture, event.assistantMessageEvent)
    return
  }
  if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
    captureToolExecution(active, capture, payload.id, featureBatch, event)
    return
  }
  if (event.type === 'message_end') captureMessageEnd(capture, event.message)
}

export function flushPendingYields(active: ActiveBatch): void {
  for (const capture of active.captures.values()) {
    for (const raw of capture.pendingCalls.values()) {
      capture.submissions.push({
        attemptIndex: capture.submissions.length,
        data: yieldedData(object(raw) && 'toolCallArguments' in raw ? raw.toolCallArguments : undefined),
        raw,
        partialText: capture.partialText,
      })
    }
    capture.pendingCalls.clear()
    capture.pendingProofCalls.clear()
  }
}
