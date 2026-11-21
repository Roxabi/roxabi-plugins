import type { NativeBatch } from './contracts'
import type { ActiveBatch } from './state'

export type JoinedNativeStop = { failures: readonly unknown[] }

export function throwJoinedStopFailures(result: JoinedNativeStop): void {
  if (result.failures.length === 1) throw result.failures[0]
  if (result.failures.length > 1) throw new AggregateError(result.failures, 'Native batch stops failed')
}

interface StopContext {
  live: Set<ActiveBatch>
  active: () => ActiveBatch | null
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

async function joinStoppedBatch(context: StopContext, owned: ActiveBatch, reason: string): Promise<JoinedNativeStop> {
  if (owned.executionDone !== null) await owned.executionDone
  let terminal = context.terminal(owned.batch)
  if (terminal === undefined) {
    if (owned.settling) throw new Error('native-settlement-terminal-unavailable')
    terminal = context.stopActive(owned, reason)
  }
  const [outcome] = await Promise.allSettled([terminal])
  return { failures: outcome.status === 'rejected' ? [outcome.reason] : [] }
}

export async function stopBatches(context: StopContext, reason: string): Promise<JoinedNativeStop> {
  const targets = new Set(context.live)
  const current = context.active()
  if (current) targets.add(current)
  const earlyFailures: unknown[] = []
  for (const batch of targets) {
    try {
      fenceOwned(batch, reason, context.present)
    } catch (error) {
      earlyFailures.push(error)
    }
  }
  try {
    await context.releaseMask()
  } catch (error) {
    try {
      context.status(`native task mask restoration failed: ${error instanceof Error ? error.message : String(error)}`)
    } catch (reportError) {
      earlyFailures.push(reportError)
    }
  }
  const results = await Promise.allSettled([...targets].map((target) => joinStoppedBatch(context, target, reason)))
  const failures = [
    ...earlyFailures,
    ...results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : result.value.failures)),
  ]
  if (earlyFailures.length > 0 || results.some((result) => result.status === 'rejected'))
    throwJoinedStopFailures({ failures })
  return { failures }
}
