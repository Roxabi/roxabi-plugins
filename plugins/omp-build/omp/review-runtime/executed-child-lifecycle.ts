import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import type { NativeBatch } from './contracts.ts'
import type { NativeBatchController } from './controller.ts'
import type { ActiveBatch } from './state.ts'

// This index contains only controller-owned, admitted active batches.
const admitted = new Map<NativeBatchController, ActiveBatch>()
const roots = new WeakMap<ActiveBatch, { ctx: ExtensionContext; id: string; sessionId: string }>()

export function indexAdmittedChildBatch(
  controller: NativeBatchController,
  active: ActiveBatch,
  ctx: ExtensionContext,
): void {
  roots.set(active, { ctx, id: ctx.agent.id, sessionId: ctx.sessionManager.getSessionId() })
  admitted.set(controller, active)
}

export function unindexAdmittedChildBatch(controller: NativeBatchController, active: ActiveBatch): void {
  if (admitted.get(controller) === active) admitted.delete(controller)
}

export function rootCurrent(active: ActiveBatch): boolean {
  const root = roots.get(active)
  return !!root && root.ctx.agent.id === root.id && root.ctx.sessionManager.getSessionId() === root.sessionId
}

export function observeChildLifecycle(controller: NativeBatchController, value: unknown): void {
  const active = admitted.get(controller)
  if (!active || active.settling || !rootCurrent(active) || !value || typeof value !== 'object') return
  const event = value as Record<string, unknown>
  if (typeof event.id !== 'string') return
  const index = active.childSlots.get(event.id)
  if (index === undefined || event.parentToolCallId !== active.admittedToolCallId) return
  const prior = active.starts.get(event.id)
  if (event.status !== 'started') {
    if (prior) prior.closed = true
    return
  }
  if (active.starts.has(event.id)) {
    active.starts.set(event.id, null)
    const guard = active.guardedChildren.get(event.id)
    if (guard) guard.valid = false
    return
  }
  const task = active.batch.tasks.tasks[index]
  if (
    !task ||
    event.index !== index ||
    event.agent !== task.agent ||
    event.detached !== false ||
    typeof event.sessionFile !== 'string' ||
    event.sessionFile.length === 0
  ) {
    active.starts.set(event.id, null)
    return
  }
  active.starts.set(event.id, {
    index,
    sessionFile: event.sessionFile,
    task,
    action: task.action,
    snapshot: task.action.snapshot,
    inputs: task.action.inputs,
    closed: false,
  })
}

function matchesStart(active: ActiveBatch, id: string, file: string, parentId: string, allowClosed: boolean): boolean {
  const root = roots.get(active)
  const start = active.starts.get(id)
  return !!(
    !active.settling &&
    active.admittedToolCallId !== null &&
    rootCurrent(active) &&
    root?.id === parentId &&
    start &&
    (allowClosed || !start.closed) &&
    start.sessionFile === file &&
    active.childSlots.get(id) === start.index &&
    active.batch.tasks.tasks[start.index] === start.task &&
    start.task.action === start.action &&
    start.action.snapshot === start.snapshot &&
    start.action.inputs === start.inputs
  )
}

export function childExecutionCurrent(
  controller: NativeBatchController,
  batch: NativeBatch,
  id: string,
  file: string,
  parentId: string,
  allowClosed = false,
): boolean {
  const active = admitted.get(controller)
  return !!active && active.batch === batch && matchesStart(active, id, file, parentId, allowClosed)
}

export function bindExecutedChild(
  id: string,
  sessionId: string,
  file: string,
  parentId: string,
): {
  controller: NativeBatchController
  batch: NativeBatch
  index: number
  model: { provider: string; id: string }
} | null {
  let owner: NativeBatchController | null = null
  let found: ActiveBatch | null = null
  for (const [controller, active] of admitted) {
    if (!matchesStart(active, id, file, parentId, false)) continue
    if (owner) return null
    owner = controller
    found = active
  }
  if (!owner || !found || found.guardedChildren.has(id)) return null
  const start = found.starts.get(id)
  if (!start) return null
  const model = found.models[start.index]
  if (!model) return null
  found.guardedChildren.set(id, { sessionId, valid: false, yieldData: null })
  return { controller: owner, batch: found.batch, index: start.index, model }
}
