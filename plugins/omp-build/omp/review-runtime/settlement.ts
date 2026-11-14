import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { nativeBatchStatus } from '../action-communication.ts'
import { flushPendingYields } from './capture'
import { groundCapturedChildren } from './child-capture.ts'
import type { NativeBatch, NativeBatchResult, NativeExecutionObservation, NativeStop } from './contracts'
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
): Promise<void> {
  flushPendingYields(active)
  const resolved = resolveTaskResult(active, event)
  let status: 'completed' | 'stopped' = 'stopped'
  let failed = false
  try {
    const prepared = await preparedReceived(active, event, resolved)
    if (await stopBeforePublication(active, prepared.result, detach)) return
    const publicationErrors = await publishRaw(active.callbacks, prepared.children, () => rootCurrent(active))
    detach(active)
    if (await stopAfterPublication(active, event, resolved, prepared, publicationErrors)) return
    const canContinue = (): boolean =>
      active.continuationClosed === null && active.retentionFailed === null && rootCurrent(active)
    if (await stopIfLate(active, prepared.result, resolved, event)) return
    status = 'completed'
    await active.callbacks.onComplete(prepared.result, canContinue)
    if (await stopIfLate(active, prepared.result, resolved, event)) return
    await active.callbacks.onSettled?.(prepared.result, canContinue)
    if (await stopIfLate(active, prepared.result, resolved, event)) return
    status = 'completed'
  } catch (error) {
    failed = true
    throw error
  } finally {
    if (!failed) presentTerminal(active, ownsPresentation, status)
  }
}

export function isolatedReceivedSettlement(
  active: ActiveBatch,
  event: NativeExecutionObservation,
  detach: (active: ActiveBatch) => void,
  ownsPresentation: (batch: NativeBatch) => boolean,
): Promise<void> {
  let isolated: NativeExecutionObservation
  try {
    isolated = structuredClone(event)
  } catch (error) {
    active.settling = true
    const message = error instanceof Error ? error.message : String(error)
    return Promise.resolve().then(async () => {
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
    })
  }
  active.settling = true
  return settleReceivedBatch(active, isolated, detach, ownsPresentation)
    .then(
      () => undefined,
      async (error) => {
        const message = error instanceof Error ? error.message : String(error)
        try {
          await active.callbacks.onStop(`settlement-failed:${message}`, null, {
            kind: 'withheld',
            cause: 'settlement-failure',
          })
        } catch {
          // The rejection is observed here; a late callback must not renew authority.
        } finally {
          presentTerminal(active, ownsPresentation, 'stopped')
        }
      },
    )
    .finally(() => {
      active.contextPublicationOwned = false
    })
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
