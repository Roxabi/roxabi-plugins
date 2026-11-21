import type { ActionMessage } from '../action-communication.ts'
import type { NativeBatchResult, NativeChildResult } from './contracts.ts'
import type { ActiveBatch } from './state.ts'

export async function stopForMissingContext(
  active: ActiveBatch,
  result: NativeBatchResult,
  children: readonly NativeChildResult[],
  notify: (active: ActiveBatch, message: ActionMessage) => Promise<void>,
): Promise<void> {
  await notify(active, {
    kind: 'blocker',
    summary: `native batch ${active.batch.operationId} needs additional context`,
    actionableFacts: children.flatMap((child) =>
      (child.contextBlock?.missing ?? []).map((item) => `${child.expectedId}: ${item.reason}`),
    ),
    nextAction: 'prepare a new action explicitly with the retained negative and additional authenticated context',
    detailRef: active.retainedResultRef ?? 'retention-unavailable',
  })
  if (!result.canPublishContext?.()) return
  active.continuationClosed = 'action-context-missing'
  await active.callbacks.onStop('action-context-missing', result, { kind: 'context-negative' })
}
