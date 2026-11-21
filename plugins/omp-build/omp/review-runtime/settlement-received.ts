import type { ActionMessage } from '../action-communication.ts'
import { object } from './capture'
import { groundCapturedChildren } from './child-capture.ts'
import { contextNegativeChildren } from './context-negative.ts'
import { stopForMissingContext } from './context-negative-stop.ts'
import type {
  NativeBatchResult,
  NativeChildResult,
  NativeExecutionObservation,
  NativeStop,
  NativeStopOrigin,
} from './contracts'
import { rootCurrent } from './executed-child-lifecycle.ts'
import { bindNativeObservations } from './observation-capture.ts'
import { blocked, integrityFailure } from './settlement-evidence'
import type { ActiveBatch } from './state'
import type { ResolvedTaskResult } from './task-result-resolution'

async function notify(active: ActiveBatch, message: ActionMessage): Promise<void> {
  try {
    await active.communication?.message(message)
  } catch {
    // A visible-message failure must not change admission or reopen the result hook.
  }
}

function terminalStop(
  children: readonly NativeChildResult[],
  resolved: ResolvedTaskResult,
  origin: NativeStopOrigin | null,
  event: NativeExecutionObservation,
): NativeStop {
  const required = children.filter((child) => child.expectedId !== null)
  if (required.length > 0 && required.every((child) => child.sdkTerminal === 'returned') && event.errors.length > 0)
    return { kind: 'withheld', cause: 'execution-errors' }
  const reportedYieldError = required.some((child) => {
    const raw = child.raw
    const extracted = object(raw) && object(raw.extractedToolData) ? raw.extractedToolData.yield : null
    return (
      (Array.isArray(extracted) && extracted.some((item) => object(item) && typeof item.error === 'string')) ||
      child.submissions.some((submission) => {
        const captured = submission.raw
        return (
          object(captured) &&
          object(captured.executionArguments) &&
          typeof captured.executionArguments.error === 'string'
        )
      })
    )
  })
  if (reportedYieldError) return { kind: 'invalid-terminal', origin }
  if (required.length === 0 || required.some((child) => child.sdkTerminal === undefined))
    return { kind: 'unattributed', origin }
  if (
    !resolved.exactCount ||
    !resolved.identitiesMatch ||
    required.some((child) => child.sdkTerminal === 'returned' && !child.usable)
  )
    return { kind: 'invalid-terminal', origin }
  if (required.every((child) => child.sdkTerminal === 'returned'))
    return origin === null ? { kind: 'withheld', cause: 'execution-errors' } : { kind: 'completed-after-stop', origin }
  return { kind: 'unattributed', origin }
}

type ReceivedSettlement = {
  children: NativeChildResult[]
  integrity: string | null
  result: NativeBatchResult
}

export async function preparedReceived(
  active: ActiveBatch,
  event: NativeExecutionObservation,
  resolved: ResolvedTaskResult,
): Promise<ReceivedSettlement> {
  const grounded = await groundCapturedChildren(active, resolved.result.children)
  let integrity = await integrityFailure(active)
  const negatives =
    integrity === null && event.errors.length === 0 && resolved.identitiesMatch
      ? contextNegativeChildren(active.batch, grounded)
      : null
  if (negatives?.invalidBinding) integrity = 'action-binding-unregistered-or-mismatched'
  let children = integrity === null ? (negatives?.children ?? grounded) : blocked(grounded, integrity)
  if (integrity === null && event.errors.length === 0 && resolved.identitiesMatch) {
    children = bindNativeObservations(active.batch, children)
  }
  const hasNegative = children.some((child) => child.contextBlock !== undefined)
  const canPublishContext = (): boolean =>
    active.contextPublicationOwned && active.retentionFailed === null && rootCurrent(active)
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

export async function stopBeforePublication(
  active: ActiveBatch,
  result: NativeBatchResult,
  detach: (active: ActiveBatch) => void,
): Promise<boolean> {
  if (active.retentionFailed === null && rootCurrent(active)) return false
  const cause = active.retentionFailed === null ? 'root-generation' : 'retention'
  if (active.retentionFailed === null) active.retentionFailed = 'native-root-generation-changed'
  detach(active)
  await active.callbacks.onStop(
    `retention-failed:${active.retentionFailed}`,
    { ...result, complete: false },
    { kind: 'withheld', cause },
  )
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
  await active.callbacks.onStop(`action-integrity-failed:${integrity}`, result, {
    kind: 'withheld',
    cause: 'integrity',
  })
}

export async function stopIfLate(
  active: ActiveBatch,
  result: NativeBatchResult,
  resolved: ResolvedTaskResult,
  event: NativeExecutionObservation,
): Promise<boolean> {
  if (active.retentionFailed === null && active.continuationClosed === null && rootCurrent(active)) return false
  if (active.retentionFailed !== null)
    await active.callbacks.onStop(`retention-failed:${active.retentionFailed}`, result, {
      kind: 'withheld',
      cause: 'retention',
    })
  else if (active.continuationClosed !== null)
    await active.callbacks.onStop(
      active.continuationClosed,
      result,
      terminalStop(result.children, resolved, active.stopOrigin, event),
    )
  else
    await active.callbacks.onStop('native-root-generation-changed', result, {
      kind: 'withheld',
      cause: 'root-generation',
    })
  return true
}

export async function stopAfterPublication(
  active: ActiveBatch,
  event: NativeExecutionObservation,
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
    await active.callbacks.onStop(`raw-publication-failed:${publicationErrors.join('; ')}`, prepared.result, {
      kind: 'withheld',
      cause: 'raw-publication',
    })
    return true
  }
  if (active.continuationClosed !== null) {
    await active.callbacks.onStop(
      active.continuationClosed,
      prepared.result,
      terminalStop(prepared.children, resolved, active.stopOrigin, event),
    )
    return true
  }
  if (await stopIfLate(active, prepared.result, resolved, event)) return true
  const negatives = prepared.children.filter((child) => child.contextBlock !== undefined)
  if (negatives.length === 0) {
    if (!resolved.complete) {
      await active.callbacks.onStop(
        incompleteReason(event, resolved),
        prepared.result,
        terminalStop(prepared.children, resolved, active.stopOrigin, event),
      )
      return true
    }
    return false
  }
  await stopForMissingContext(active, prepared.result, negatives, notify)
  return true
}

function incompleteReason(event: NativeExecutionObservation, resolved: ResolvedTaskResult): string {
  if (event.errors.length > 0) return `native-execution-failed:${event.errors.join('; ')}`
  if (!resolved.exactCount) return 'unexpected-required-child-count'
  if (!resolved.identitiesMatch) return 'unexpected-required-child-id'
  return resolved.result.children.find((child) => !child.usable)?.reason ?? 'required-child-invalid'
}
