import type { ToolResultEvent } from '@oh-my-pi/pi-coding-agent'
import type { ResolvedTaskResult } from './bridge'
import { capturedChild, resolveTaskResult } from './bridge'
import { flushPendingYields } from './capture'
import type { NativeBatchCallbacks, NativeBatchResult, NativeChildResult } from './contracts'
import type { ActiveBatch } from './state'

async function publishRaw(callbacks: NativeBatchCallbacks, children: readonly NativeChildResult[]): Promise<string[]> {
  const errors: string[] = []
  for (const child of children) {
    try {
      await callbacks.onChildResult?.(child)
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  return errors
}

export function settleReceivedBatch(
  active: ActiveBatch,
  event: ToolResultEvent,
  detach: (active: ActiveBatch) => void,
): Promise<void> {
  flushPendingYields(active)
  const resolved = resolveTaskResult(active, event)
  return (async (): Promise<void> => {
    const publicationErrors = await publishRaw(active.callbacks, resolved.result.children)
    detach(active)
    if (publicationErrors.length > 0) {
      await active.callbacks.onStop(`raw-publication-failed:${publicationErrors.join('; ')}`, resolved.result)
      return
    }
    if (!resolved.complete) {
      await active.callbacks.onStop(incompleteReason(event, resolved), resolved.result)
      return
    }
    await active.callbacks.onComplete(resolved.result)
    await active.callbacks.onSettled?.(resolved.result)
  })()
}

function incompleteReason(event: ToolResultEvent, resolved: ResolvedTaskResult): string {
  if (event.isError) return 'root-task-is-error'
  if (!resolved.exactCount) return 'unexpected-required-child-count'
  if (!resolved.identitiesMatch) return 'unexpected-required-child-id'
  return resolved.result.children.find((child) => !child.usable)?.reason ?? 'required-child-invalid'
}

export function settleStoppedBatch(
  active: ActiveBatch,
  reason: string,
  detach: (active: ActiveBatch) => void,
): Promise<void> {
  active.settling = true
  detach(active)
  flushPendingYields(active)
  const children = stoppedChildren(active)
  const result: NativeBatchResult = { batch: active.batch, children, raw: null, complete: false }
  return (async (): Promise<void> => {
    const publicationErrors = await publishRaw(active.callbacks, children)
    const stopReason =
      publicationErrors.length === 0 ? reason : `raw-publication-failed:${publicationErrors.join('; ')}`
    await active.callbacks.onStop(stopReason, result)
  })()
}

function stoppedChildren(active: ActiveBatch) {
  return [
    ...active.batch.tasks.tasks.map((task) => capturedChild(active, null, task.name)),
    ...[...active.captures.keys()].map((childId) => capturedChild(active, null, null, childId)),
  ]
}
