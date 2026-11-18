import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { nativeBatchStatus } from '../action-communication.ts'
import { flushPendingYields } from './capture'
import { groundCapturedChildren } from './child-capture.ts'
import type {
  NativeBatch,
  NativeBatchResult,
  NativeExecutionObservation,
  NativeStop,
  NativeSuccessor,
} from './contracts'
import { rootCurrent } from './executed-child-lifecycle.ts'
import { blocked, integrityFailure, publishRaw } from './settlement-evidence'
import { preparedReceived, stopAfterPublication, stopBeforePublication, stopIfLate } from './settlement-received'
import type { ActiveBatch } from './state'
import { capturedChild, resolveTaskResult } from './task-result-resolution'

export function ownsBatchPresentation(
  active: ActiveBatch,
  lastActivated: ActiveBatch | null,
  sessionId: string | null,
  root: ExtensionContext | null,
): boolean {
  return active === lastActivated && sessionId === (root?.sessionManager.getSessionId() ?? null)
}

function presentTerminal(
  active: ActiveBatch,
  ownsPresentation: (batch: NativeBatch) => boolean,
  status: 'completed' | 'stopped',
): void {
  if (!ownsPresentation(active.batch)) return
  try {
    const phase =
      status === 'completed'
        ? 'native output received'
        : active.admittedToolCallId === null
          ? 'withdrawn · executor not started'
          : 'continuation stopped'
    active.communication?.status(nativeBatchStatus(active.batch, phase))
  } catch {
    // Status presentation cannot change settlement.
  }
}

export async function settleReceivedBatch(
  active: ActiveBatch,
  event: NativeExecutionObservation,
  detach: (active: ActiveBatch) => void,
  ownsPresentation: (batch: NativeBatch) => boolean = () => true,
  releasePresentation: () => Promise<void> = async () => {},
): Promise<NativeSuccessor | undefined> {
  const executionDone = active.executionDone
  flushPendingYields(active)
  const resolved = resolveTaskResult(active, event)
  let status: 'completed' | 'stopped' = 'stopped'
  let failed = false
  try {
    const prepared = await preparedReceived(active, event, resolved)
    if (await stopBeforePublication(active, prepared.result, detach)) return undefined
    const publicationErrors = await publishRaw(active.callbacks, prepared.children, () => rootCurrent(active))
    detach(active)
    if (await stopAfterPublication(active, event, resolved, prepared, publicationErrors)) return undefined
    // Observation is complete before settlement is queued. The owned tool
    // awaits settlement, so agent_end cannot restore its mask before a
    // callback announces the next batch.
    await releasePresentation()
    const canContinue = (): boolean =>
      active.continuationClosed === null &&
      active.retentionFailed === null &&
      !active.sdkSignal?.aborted &&
      rootCurrent(active)
    if (await stopIfLate(active, prepared.result, resolved, event)) return undefined
    await active.callbacks.onComplete(prepared.result, canContinue)
    // Host/session stops may fence during onComplete; notify onStop before dropping the terminal.
    if (await stopIfLate(active, prepared.result, resolved, event)) return undefined
    const observed = await active.callbacks.onSettled?.(prepared.result, canContinue)
    const successor = typeof observed === 'function' ? observed : undefined
    if (successor !== undefined) {
      active.handoffPending = true
      if (executionDone !== null) await executionDone
    }
    if (await stopIfLate(active, prepared.result, resolved, event)) return undefined
    status = 'completed'
    return successor
  } catch (error) {
    failed = true
    throw error
  } finally {
    if (!failed) presentTerminal(active, ownsPresentation, status)
  }
}

export async function isolatedReceivedSettlement(
  active: ActiveBatch,
  event: NativeExecutionObservation,
  detach: (active: ActiveBatch) => void,
  ownsPresentation: (batch: NativeBatch) => boolean,
  releasePresentation: () => Promise<void> = async () => {},
): Promise<NativeSuccessor | undefined> {
  let isolated: NativeExecutionObservation
  try {
    isolated = structuredClone(event)
  } catch (error) {
    active.settling = true
    const message = error instanceof Error ? error.message : String(error)
    try {
      await Promise.resolve()
      detach(active)
      try {
        await active.callbacks.onStop(`settlement-isolation-failed:${message}`, null, {
          kind: 'withheld',
          cause: 'settlement-failure',
        })
      } catch {
        // Observed. The live SDK event is not reused and no substitute event is built.
      } finally {
        presentTerminal(active, ownsPresentation, 'stopped')
      }
      return undefined
    } finally {
      await releasePresentation()
    }
  }
  active.settling = true
  try {
    return await settleReceivedBatch(active, isolated, detach, ownsPresentation, releasePresentation)
  } catch (error) {
    return await reportSettlementFailure(active, error, ownsPresentation)
  } finally {
    try {
      await releasePresentation()
    } finally {
      active.contextPublicationOwned = false
    }
  }
}

async function reportSettlementFailure(
  active: ActiveBatch,
  error: unknown,
  ownsPresentation: (batch: NativeBatch) => boolean,
): Promise<never> {
  if (active.continuationClosed === 'action-context-missing') {
    presentTerminal(active, ownsPresentation, 'stopped')
    throw error
  }
  const message = error instanceof Error ? error.message : String(error)
  try {
    await active.callbacks.onStop(`settlement-failed:${message}`, null, {
      kind: 'withheld',
      cause: 'settlement-failure',
    })
  } catch (stopError) {
    throw new AggregateError([error, stopError], `Settlement failed: ${message}; stop callback failed`, {
      cause: error,
    })
  } finally {
    presentTerminal(active, ownsPresentation, 'stopped')
  }
  throw error
}

function stoppedDisposition(
  active: ActiveBatch,
  integrity: string | null,
  publicationErrors: readonly string[],
  reason: string,
): { reason: string; stop: NativeStop } {
  if (integrity !== null)
    return { reason: `action-integrity-failed:${integrity}`, stop: { kind: 'withheld', cause: 'integrity' } }
  if (publicationErrors.length > 0)
    return {
      reason: `raw-publication-failed:${publicationErrors.join('; ')}`,
      stop: { kind: 'withheld', cause: 'raw-publication' },
    }
  const origin = active.stopOrigin
  return {
    reason,
    stop:
      origin !== null && active.admittedToolCallId === null
        ? { kind: 'interrupted', origin, proof: 'not-dispatched' }
        : { kind: 'unattributed', origin },
  }
}

export function settleStoppedBatch(
  active: ActiveBatch,
  reason: string,
  detach: (active: ActiveBatch) => void,
  ownsPresentation: (batch: NativeBatch) => boolean,
): Promise<void> {
  active.settling = true
  active.continuationClosed = reason
  detach(active)
  flushPendingYields(active)
  return (async (): Promise<void> => {
    try {
      const grounded = await groundCapturedChildren(active, stoppedChildren(active))
      const integrity = await integrityFailure(active)
      const children = blocked(grounded, integrity ?? reason)
      const usableBlocked = integrity === null ? children : blocked(children, integrity)
      const result: NativeBatchResult = { batch: active.batch, children: usableBlocked, raw: null, complete: false }
      const publicationErrors = await publishRaw(active.callbacks, usableBlocked)
      const disposition = stoppedDisposition(active, integrity, publicationErrors, reason)
      await active.callbacks.onStop(disposition.reason, result, disposition.stop)
    } finally {
      presentTerminal(active, ownsPresentation, 'stopped')
    }
  })()
}

function stoppedChildren(active: ActiveBatch) {
  return [
    ...active.batch.tasks.tasks.map((task) => capturedChild(active, null, task.name)),
    ...[...active.captures.keys()].map((childId) => capturedChild(active, null, null, childId)),
  ]
}
