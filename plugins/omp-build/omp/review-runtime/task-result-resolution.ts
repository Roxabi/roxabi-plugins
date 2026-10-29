import { isDeepStrictEqual } from 'node:util'
import type { ToolResultEvent } from '@oh-my-pi/pi-coding-agent'
import { producerOutputValid } from '../../dist/contracts.js'
import { nativeFeatureProfiles } from '../../roxabi/native-feature-profiles.ts'
import { nativeReviewProfiles } from '../../roxabi/native-review-profiles.ts'
import { nativeSnapshot, object } from './capture'
import { captureChildResult } from './child-capture'
import type { NativeBatchResult, NativeChildResult } from './contracts'
import type { ActiveBatch } from './state'

export type ResolvedTaskResult = {
  result: NativeBatchResult
  complete: boolean
  exactCount: boolean
  identitiesMatch: boolean
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
function childIdentityMatches(
  active: ActiveBatch,
  task: ActiveBatch['batch']['tasks']['tasks'][number],
  taskIndex: number,
  value: unknown,
  child: NativeChildResult,
): boolean {
  return (
    child.id !== null && object(value) && value.agent === task.agent && active.childSlots.get(child.id) === taskIndex
  )
}

function guardedChildMatches(
  active: ActiveBatch,
  task: ActiveBatch['batch']['tasks']['tasks'][number],
  taskIndex: number,
  value: unknown,
  child: NativeChildResult,
): boolean {
  const identityMatches = childIdentityMatches(active, task, taskIndex, value, child)
  const guard = child.id === null ? undefined : active.guardedChildren.get(child.id)
  const profile = [...nativeFeatureProfiles, ...nativeReviewProfiles].find((candidate) => candidate.name === task.agent)
  return (
    identityMatches &&
    !!guard?.valid &&
    guard.yieldData !== null &&
    isDeepStrictEqual(guard.yieldData, child.structured) &&
    !!profile &&
    producerOutputValid(profile.output, child.structured)
  )
}

function captureAssociatedChildren(
  active: ActiveBatch,
  values: unknown[],
  terminalByTaskIndex: Map<number, { terminalIndex: number; value: unknown }>,
  associatedExactly: boolean,
) {
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
    if (!childIdentityMatches(active, task, taskIndex, terminal.value, child)) exactAssociation = false
    if (!guardedChildMatches(active, task, taskIndex, terminal.value, child)) {
      child.usable = false
      child.reason = 'executed-child-guard-failed'
    }
    children.push(child)
  }
  for (const [index, value] of values.entries()) {
    if (!consumed.has(index)) children.push(capturedChild(active, value, null))
  }
  return { children, exactAssociation }
}

export function resolveTaskResult(active: ActiveBatch, event: ToolResultEvent): ResolvedTaskResult {
  const values = object(event.details) && Array.isArray(event.details.results) ? event.details.results : []
  const { terminalByTaskIndex, exactAssociation: associatedExactly } = terminalAssociations(
    values,
    active.batch.tasks.tasks.length,
  )
  const { children, exactAssociation } = captureAssociatedChildren(
    active,
    values,
    terminalByTaskIndex,
    associatedExactly,
  )
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
