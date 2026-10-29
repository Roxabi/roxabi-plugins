import type { ExtensionContext, ToolResultEvent } from '@oh-my-pi/pi-coding-agent'
import type { ActionMessage } from '../action-communication.ts'
import { verifyHostAction } from './action-registry.ts'
import { flushPendingYields } from './capture'
import { groundCapturedChildren } from './child-capture.ts'
import { contextNegativeChildren } from './context-negative.ts'
import { stopForMissingContext } from './context-negative-stop.ts'
import type { NativeBatch, NativeBatchCallbacks, NativeBatchResult, NativeChildResult } from './contracts'
import { bindNativeObservations } from './observation-capture.ts'
import type { ActiveBatch } from './state'
import { capturedChild, type ResolvedTaskResult, resolveTaskResult } from './task-result-resolution'

async function publishRaw(callbacks: NativeBatchCallbacks, children: readonly NativeChildResult[]): Promise<string[]> {
  const errors: string[] = []
  for (const child of children) {
    if (child.canPublishContext && !child.canPublishContext()) break
    try {
      await callbacks.onChildResult?.(child)
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  return errors
}

async function notify(active: ActiveBatch, message: ActionMessage): Promise<void> {
  try {
    await active.communication?.message(message)
  } catch {
    // A visible-message failure must not change admission or reopen the result hook.
  }
}
async function integrityFailure(active: ActiveBatch): Promise<string | null> {
  const codes: string[] = []
  for (const task of active.batch.tasks.tasks) {
    const snapshot = task.action?.snapshot
    if (snapshot === undefined) {
      codes.push('action-handle-missing')
      continue
    }
    const verified = await verifyHostAction(snapshot)
    if (!verified.ok) codes.push(...verified.diagnostics.map((item) => item.code))
  }
  return codes.length === 0 ? null : [...new Set(codes)].join(',')
}

function blocked(children: readonly NativeChildResult[], reason: string): NativeChildResult[] {
  return children.map((child) => ({ ...child, usable: false, reason }))
}

type ReceivedSettlement = {
  children: NativeChildResult[]
  integrity: string | null
  result: NativeBatchResult
}

async function preparedReceived(
  active: ActiveBatch,
  event: ToolResultEvent,
  resolved: ResolvedTaskResult,
): Promise<ReceivedSettlement> {
  const grounded = await groundCapturedChildren(active, resolved.result.children)
  let integrity = await integrityFailure(active)
  const negatives =
    integrity === null && event.isError !== true && resolved.identitiesMatch
      ? contextNegativeChildren(active.batch, grounded)
      : null
  if (negatives?.invalidBinding) integrity = 'action-binding-unregistered-or-mismatched'
  let children = integrity === null ? (negatives?.children ?? grounded) : blocked(grounded, integrity)
  if (integrity === null && event.isError !== true && resolved.identitiesMatch) {
    children = bindNativeObservations(active.batch, children)
  }
  const hasNegative = children.some((child) => child.contextBlock !== undefined)
  const canPublishContext = (): boolean => active.contextPublicationOwned && active.retentionFailed === null
  if (hasNegative) {
    active.contextPublicationOwned = active.continuationClosed === null && active.retentionFailed === null
    children = children.map((child) => ({ ...child, canPublishContext }))
  }
  return {
    children,
    integrity,
    result: {
      ...resolved.result,
      children,
      ...(hasNegative ? { canPublishContext } : {}),
      complete:
        integrity === null &&
        resolved.complete &&
        active.continuationClosed === null &&
        active.retentionFailed === null,
    },
  }
}

async function stopBeforePublication(
  active: ActiveBatch,
  result: NativeBatchResult,
  detach: (active: ActiveBatch) => void,
): Promise<boolean> {
  if (active.retentionFailed === null) return false
  detach(active)
  await active.callbacks.onStop(`retention-failed:${active.retentionFailed}`, { ...result, complete: false })
  return true
}

async function notifyIntegrity(active: ActiveBatch, integrity: string, result: NativeBatchResult): Promise<void> {
  await notify(active, {
    kind: 'blocker',
    summary: `native batch ${active.batch.operationId} blocked: action integrity failed`,
    actionableFacts: [`reason: ${integrity}`, 'credentialMode: procedural-fallback'],
    nextAction: 'restore the registered action snapshot or prepare a new one before retrying',
    detailRef: active.retainedResultRef ?? 'retention-unavailable',
  })
  await active.callbacks.onStop(`action-integrity-failed:${integrity}`, result)
}

async function stopIfLate(active: ActiveBatch, result: NativeBatchResult): Promise<boolean> {
  if (active.retentionFailed === null && active.continuationClosed === null) return false
  const reason =
    active.retentionFailed !== null
      ? `retention-failed:${active.retentionFailed}`
      : (active.continuationClosed ?? 'continuation-closed')
  await active.callbacks.onStop(reason, result)
  return true
}

async function stopAfterPublication(
  active: ActiveBatch,
  event: ToolResultEvent,
  resolved: ResolvedTaskResult,
  prepared: ReceivedSettlement,
  publicationErrors: readonly string[],
): Promise<boolean> {
  if (prepared.result.canPublishContext && !prepared.result.canPublishContext()) return true
  if (prepared.integrity !== null) {
    await notifyIntegrity(active, prepared.integrity, prepared.result)
    return true
  }
  if (publicationErrors.length > 0) {
    await active.callbacks.onStop(`raw-publication-failed:${publicationErrors.join('; ')}`, prepared.result)
    return true
  }
  if (active.continuationClosed !== null) {
    await active.callbacks.onStop(active.continuationClosed, prepared.result)
    return true
  }
  if (await stopIfLate(active, prepared.result)) return true
  const negatives = prepared.children.filter((child) => child.contextBlock !== undefined)
  if (negatives.length === 0) {
    if (!resolved.complete) {
      await active.callbacks.onStop(incompleteReason(event, resolved), prepared.result)
      return true
    }
    return false
  }
  await stopForMissingContext(active, prepared.result, negatives, notify)
  return true
}

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
    active.communication?.status(`omp-build: native batch ${active.batch.operationId} ${status}`)
  } catch {
    // Status presentation cannot change settlement.
  }
}

export async function settleReceivedBatch(
  active: ActiveBatch,
  event: ToolResultEvent,
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
    const publicationErrors = await publishRaw(active.callbacks, prepared.children)
    detach(active)
    if (await stopAfterPublication(active, event, resolved, prepared, publicationErrors)) return
    const canContinue = (): boolean => active.continuationClosed === null && active.retentionFailed === null
    if (await stopIfLate(active, prepared.result)) return
    await active.callbacks.onComplete(prepared.result, canContinue)
    if (await stopIfLate(active, prepared.result)) return
    await active.callbacks.onSettled?.(prepared.result, canContinue)
    if (await stopIfLate(active, prepared.result)) return
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
  event: ToolResultEvent,
  detach: (active: ActiveBatch) => void,
  ownsPresentation: (batch: NativeBatch) => boolean,
): Promise<void> {
  let isolated: ToolResultEvent
  try {
    isolated = structuredClone(event)
  } catch (error) {
    active.settling = true
    const message = error instanceof Error ? error.message : String(error)
    return Promise.resolve().then(async () => {
      detach(active)
      try {
        await active.callbacks.onStop(`settlement-isolation-failed:${message}`, null)
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
          await active.callbacks.onStop(`settlement-failed:${message}`, null)
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
      const stopReason =
        integrity !== null
          ? `action-integrity-failed:${integrity}`
          : publicationErrors.length === 0
            ? reason
            : `raw-publication-failed:${publicationErrors.join('; ')}`
      await active.callbacks.onStop(stopReason, result)
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
