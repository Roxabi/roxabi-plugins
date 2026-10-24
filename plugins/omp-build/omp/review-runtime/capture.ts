import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { BashToolDetails, BashToolInput, SubagentEventPayload } from '@oh-my-pi/pi-coding-agent'
import type { Json, NativeProofBashCall, NativeProofDirective } from './contracts'
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
function bashInput(value: unknown): value is BashToolInput {
  return object(value) && typeof value.command === 'string'
}
function bashDetails(value: unknown): value is BashToolDetails {
  return object(value) && (value.exitCode === undefined || typeof value.exitCode === 'number')
}

function bashExitCode(value: unknown, isError: unknown): number | null {
  if (!object(value) || !bashDetails(value.details)) return null
  const details = value.details
  if (typeof details.exitCode === 'number') return details.exitCode
  if (isError !== false || details.async !== undefined || details.service !== undefined) return null
  if (details.timedOut === true || details.terminalId !== undefined) return null
  return 0
}
function rememberBashCall(
  completed: Map<string, NativeProofBashCall>,
  ambiguous: Set<string>,
  toolCallId: string,
  pending: { input: Json; effectiveCwd: string | null },
  event: { result: unknown; isError?: unknown },
  conflicts?: NativeProofBashCall[],
): void {
  const call: NativeProofBashCall = {
    toolCallId,
    input: pending.input,
    effectiveCwd: pending.effectiveCwd,
    result: nativeSnapshot(event.result),
    exitCode: bashExitCode(event.result, event.isError),
  }
  const existing = completed.get(toolCallId)
  if (existing === undefined && !ambiguous.has(toolCallId)) {
    completed.set(toolCallId, call)
    return
  }
  if (conflicts !== undefined) {
    if (existing !== undefined) conflicts.push(existing)
    conflicts.push(call)
  }
  completed.delete(toolCallId)
  ambiguous.add(toolCallId)
}
/** Mirrors the installed public Bash resolver's supported host-path cases without importing it at runtime. */
function effectiveBashCwd(value: unknown, sessionCwd: string | null): string | null {
  if (!bashInput(value) || typeof sessionCwd !== 'string') return null
  if (value.cwd !== undefined && typeof value.cwd !== 'string') return null

  const requested = value.cwd ?? sessionCwd
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(requested)) return null

  const home = homedir()
  const expanded =
    requested === '~'
      ? home
      : requested.startsWith('~/') || requested.startsWith('~\\')
        ? home + requested.slice(1)
        : requested.startsWith('~')
          ? join(home, requested.slice(1))
          : requested
  if (/^\/+$/.test(expanded)) return sessionCwd
  return isAbsolute(expanded) ? expanded : resolve(sessionCwd, expanded)
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
  }
  active.captures.set(childId, capture)
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
function proofDirective(active: ActiveBatch, childId: string): NativeProofDirective | null {
  return active.batch.tasks.tasks.find((task) => task.name === childId)?.proofEvidence ?? null
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
  featureBatch: boolean,
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
  if (proofDirective(active, childId) !== null) capture.pendingProofCalls.set(event.toolCallId, pending)
  if (featureBatch) capture.pendingBashCalls.set(event.toolCallId, pending)
}
function captureCompletedBashExecution(
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
  if (event.type === 'tool_execution_end' && event.toolName === 'bash') captureCompletedBashExecution(capture, event)
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
