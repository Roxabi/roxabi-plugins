import type { NativeBatch } from './contracts'
import type { ActiveBatch } from './state'

interface StopContext {
  live: Set<ActiveBatch>
  active: () => ActiveBatch | null
  retired: (active: ActiveBatch) => boolean
  terminal: (batch: NativeBatch) => Promise<void> | undefined
  present: (active: ActiveBatch, phase: string) => void
  releaseMask: (batch?: NativeBatch) => Promise<void>
  status: (message: string) => void
  stopActive: (active: ActiveBatch, reason: string) => Promise<void>
}

function fenceOwned(owned: ActiveBatch, reason: string, present: StopContext['present']): void {
  owned.contextPublicationOwned = false
  if (owned.continuationClosed === null) owned.continuationClosed = reason
  if (owned.stopOrigin === null) owned.stopOrigin = 'host-stop'
  present(owned, 'stopping')
  owned.executionAbort?.abort(reason)
}

export async function stopOwnedBatch(context: StopContext, batch: NativeBatch, reason: string): Promise<void> {
  const owned = [...context.live].find((active) => active.batch === batch) ?? null
  if (owned) fenceOwned(owned, reason, context.present)
  try {
    await context.releaseMask(batch)
  } catch (error) {
    context.status(`native task mask restoration failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (owned !== null && owned.executionDone !== null) {
    await owned.executionDone
    const finished = context.terminal(batch)
    if (finished !== undefined) await finished
    return
  }
  const terminal = context.terminal(batch)
  if (terminal !== undefined) return await terminal
  if (!owned || owned.settling) return
  await context.stopActive(owned, reason)
}

export async function stopDeferredHandoffs(context: StopContext, reason: string): Promise<void> {
  await Promise.all(
    [...context.live]
      .filter((active) => active.handoffPending)
      .map((active) => stopOwnedBatch(context, active.batch, reason)),
  )
}

export async function stopBatches(context: StopContext, reason: string): Promise<void> {
  const targets = new Set(context.live)
  const current = context.active()
  if (current) targets.add(current)
  for (const batch of targets) fenceOwned(batch, reason, context.present)
  try {
    await context.releaseMask()
  } catch (error) {
    context.status(`native task mask restoration failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    const active = context.active()
    if (!active) return
    if (active.executionDone !== null) {
      await active.executionDone
      const finished = context.terminal(active.batch)
      if (finished !== undefined) await finished
      return
    }
    const terminal = context.terminal(active.batch)
    if (terminal !== undefined) return await terminal
    if (active.settling) return
    await context.stopActive(active, reason)
  } finally {
    const pending = [...targets]
      .filter((target) => target.handoffPending || context.retired(target))
      .map((target) => context.terminal(target.batch))
      .filter((terminal) => terminal !== undefined)
    await Promise.all(pending)
  }
}
