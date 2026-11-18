import { canonicalValueDigest } from '../../dist/contracts.js'
import type { NativeObservedToolCall, NativeToolObservation } from '../../engine/native-tool-observation-schema.ts'
import { bashExitCode } from './bash-call.ts'
import { nativeSnapshot, object } from './capture.ts'
import type { Json } from './contracts.ts'

export type ObservedToolCallState = {
  ordinal: number
  toolCallId: string
  toolName: string
  inputDigest: string | null
  resultDigest: string | null
  completion: NativeObservedToolCall['completion']
  isError: boolean | null
  exitCode: number | null
}

export type GuardedChildObservation = {
  sessionId: string
  valid: boolean
  yieldData: Json | null
  actionId: string
  observedCalls: ObservedToolCallState[]
}

function wireDigest(value: unknown): string | null {
  const snapshot = nativeSnapshot(value)
  if (snapshot === null) return null
  return canonicalValueDigest(snapshot)
}

function deferredMarkers(result: unknown): boolean {
  if (!object(result) || !object(result.details)) return false
  const details = result.details
  return (
    details.async !== undefined ||
    details.service !== undefined ||
    details.timedOut === true ||
    details.terminalId !== undefined
  )
}

/** Bash reuses shared C3 bashExitCode; non-Bash keeps numeric details.exitCode only (never invent 0). */
function observedExitCode(toolName: string, result: unknown, isError: unknown): number | null {
  if (toolName === 'bash') return bashExitCode(result, isError)
  if (!object(result) || !object(result.details)) return null
  return typeof result.details.exitCode === 'number' ? result.details.exitCode : null
}

function entryFrom(state: ObservedToolCallState): NativeObservedToolCall {
  return {
    ordinal: state.ordinal,
    toolCallId: state.toolCallId,
    toolName: state.toolName,
    inputDigest: state.inputDigest,
    resultDigest: state.resultDigest,
    completion: state.completion,
    isError: state.isError,
    exitCode: state.exitCode,
  }
}

function appendCall(
  guard: GuardedChildObservation,
  state: Omit<ObservedToolCallState, 'ordinal'>,
): ObservedToolCallState {
  const entry: ObservedToolCallState = { ...state, ordinal: guard.observedCalls.length }
  guard.observedCalls.push(entry)
  return entry
}

export function observeToolExecutionStart(
  guard: GuardedChildObservation,
  event: { toolCallId: string; toolName: string; args: unknown },
): void {
  for (const prior of guard.observedCalls) {
    if (prior.toolCallId === event.toolCallId && prior.completion === 'pending') prior.completion = 'ambiguous'
  }
  appendCall(guard, {
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    inputDigest: wireDigest(event.args),
    resultDigest: null,
    completion: 'pending',
    isError: null,
    exitCode: null,
  })
}

export function observeToolExecutionEnd(
  guard: GuardedChildObservation,
  event: { toolCallId: string; toolName: string; result: unknown; isError?: unknown },
): void {
  const resultDigest = wireDigest(event.result)
  const isError = typeof event.isError === 'boolean' ? event.isError : null
  const exitCode = observedExitCode(event.toolName, event.result, event.isError)
  const completion = resultDigest === null ? 'unavailable' : deferredMarkers(event.result) ? 'deferred' : 'returned'
  let matched: ObservedToolCallState | undefined
  for (let index = guard.observedCalls.length - 1; index >= 0; index -= 1) {
    const candidate = guard.observedCalls[index]
    if (candidate?.toolCallId === event.toolCallId && candidate.completion === 'pending') {
      matched = candidate
      break
    }
  }
  if (matched === undefined) {
    appendCall(guard, {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      inputDigest: null,
      resultDigest,
      completion: completion === 'returned' ? 'ambiguous' : completion === 'deferred' ? 'deferred' : 'unavailable',
      isError,
      exitCode,
    })
    return
  }
  if (matched.toolName !== event.toolName) {
    matched.completion = 'ambiguous'
    matched.resultDigest = resultDigest
    matched.isError = isError
    matched.exitCode = exitCode
    return
  }
  matched.resultDigest = resultDigest
  matched.completion = completion
  matched.isError = isError
  matched.exitCode = exitCode
}

export function snapshotObservedTools(
  guard: GuardedChildObservation | undefined,
  childId: string | null,
  settling: boolean,
): NativeToolObservation | undefined {
  if (guard === undefined || childId === null || childId.length === 0 || guard.actionId.length === 0) return undefined
  const boundary: NativeToolObservation['boundary'] = !guard.valid ? 'invalid' : settling ? 'closed' : 'open'
  const closedBy: NativeToolObservation['closedBy'] = boundary === 'closed' && settling ? 'settlement-fence' : null
  return {
    format: 'omp-build-native-tool-observation/1',
    scope: 'guarded-tool-admission',
    actionId: guard.actionId,
    childId,
    sessionId: guard.sessionId,
    boundary,
    closedBy,
    // Snapshot values; leave pending/deferred/ambiguous unresolved by the fence.
    calls: guard.observedCalls.map(entryFrom),
  }
}
