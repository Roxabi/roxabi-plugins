import type { NativeBatch } from './contracts'
import { rootCurrent } from './executed-child-lifecycle.ts'
import type { ActiveBatch } from './state'

/** Bind one unique child slot after the controller has checked its current execution. */
export function bindChildSlot(
  active: ActiveBatch,
  id: string,
  index: number,
  model: { provider: string; id: string },
): boolean {
  if (!active.batch.tasks.tasks[index] || active.childSlots.has(id)) return false
  for (const slot of active.childSlots.values()) if (slot === index) return false
  active.childSlots.set(id, index)
  active.models[index] = model
  return true
}

/** Resolve the execution fence only for the live owner of this batch. */
export function finishOwnedExecution(live: ReadonlySet<ActiveBatch>, batch: NativeBatch): void {
  const active = [...live].find((item) => item.batch === batch)
  if (!active) return
  const finish = active.finishExecution
  active.finishExecution = null
  active.executionDone = null
  finish?.()
}

/** Only an admitted live child in the current root may contribute capture. */
export function admittedChild(active: ActiveBatch | null, batch: NativeBatch, id: string, sessionId: string) {
  if (
    !active ||
    active.settling ||
    active.batch !== batch ||
    active.admittedToolCallId === null ||
    !rootCurrent(active)
  )
    return null
  const guard = active.guardedChildren.get(id)
  return guard?.sessionId === sessionId ? guard : null
}
