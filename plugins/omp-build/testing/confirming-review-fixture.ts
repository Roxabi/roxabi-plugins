import type { Result } from '../engine/result.ts'
import type { PreparedUwAction, ReviewActionBatch } from '../roxabi/uw-action-contract.ts'
import type { UwOperations } from '../roxabi/uw-contract.ts'
import { admitsConfirmingReviewBatchItem } from './review-batch-fixture.ts'

async function confirmDistinctReviewAction(
  operations: UwOperations,
  item: ReviewActionBatch['actions'][number],
  fixturePreparedAction: (actionId: string) => PreparedUwAction,
): Promise<Result<PreparedUwAction>> {
  const existing = await operations.prepareAction(item.request, item.projection)
  if (!existing.ok) return existing
  const distinct = fixturePreparedAction(item.request.actionId)
  if (distinct.inputs.fingerprint !== existing.value.inputs.fingerprint) return { ok: false, diagnostics: [] }
  const replay = await operations.replayActionInputs({ reviewed: distinct.inputs, request: item.request })
  if (!replay.ok || replay.value.fingerprint !== distinct.inputs.fingerprint) return { ok: false, diagnostics: [] }
  const verified = await operations.verifyAction(distinct.snapshot)
  if (!verified.ok) return verified
  return { ok: true, value: distinct }
}

export async function confirmingReviewActions(
  operations: UwOperations,
  input: ReviewActionBatch,
  fixturePreparedAction: (actionId: string) => PreparedUwAction,
): Promise<Result<readonly PreparedUwAction[]>> {
  const first = input.actions[0]
  if (first === undefined || first.projection.taskName !== 'spec' || first.projection.assignedChunk !== null) {
    return { ok: false, diagnostics: [] }
  }
  const prepared: PreparedUwAction[] = []
  const ids = new Set<string>()
  const names = new Set<string>()
  const commonRequest = JSON.stringify({ ...first.request, actionId: '' })
  const commonProjection = JSON.stringify({
    contextWindow: first.projection.contextWindow,
    chunks: first.projection.chunks,
  })
  for (const [index, item] of input.actions.entries()) {
    if (!admitsConfirmingReviewBatchItem(item, index, commonRequest, commonProjection, ids, names)) {
      return { ok: false, diagnostics: [] }
    }
    ids.add(item.request.actionId)
    names.add(item.projection.taskName)
    const distinct = await confirmDistinctReviewAction(operations, item, fixturePreparedAction)
    if (!distinct.ok) return distinct
    prepared.push(distinct.value)
  }
  return { ok: true, value: prepared }
}
