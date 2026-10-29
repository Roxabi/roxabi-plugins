import { isDeepStrictEqual } from 'node:util'
import {
  authorizeReviewContextSuccessor,
  type CanonicalRecord,
  type DecodedHistory,
  parseRecord,
  reviewActionId,
} from '../dist/contracts.js'
import type { PublishedRecord } from './github-publisher'
import type { PreparedReviewBatch } from './review-contract'

function successorTaskMismatch(
  prepared: PreparedReviewBatch,
  inventory: Extract<CanonicalRecord, { kind: 'review-attempt' }>,
): boolean {
  const payload = inventory.payload
  if (payload.stage !== 'initial' || payload.purpose !== 'review') return false
  const expanded = payload.inputSnapshot.manifest.expandedContext
  if (
    prepared.batch.tasks.tasks.length !== payload.slots.length ||
    payload.slots.some(
      (slot) =>
        prepared.batch.tasks.tasks.filter(
          (task) =>
            task.name === slot.slotId &&
            isDeepStrictEqual(slot.action, { actionId: task.action.snapshot.actionId, inputs: task.action.inputs }),
        ).length !== 1,
    )
  )
    return true
  for (const task of prepared.batch.tasks.tasks) {
    if (
      task.action === undefined ||
      task.action.snapshot.actionId !== reviewActionId(payload.candidateGitSHA, task.name, expanded) ||
      !isDeepStrictEqual(task.action.inputs, payload.inputSnapshot)
    )
      return true
  }
  return false
}

export async function publishReviewInventory(input: {
  prepared: PreparedReviewBatch
  initialInventoryId: string | undefined
  inventories: string[]
  readHistory: () => Promise<DecodedHistory>
  publish: (record: CanonicalRecord) => Promise<PublishedRecord>
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const parsed = parseRecord(input.prepared.inventory)
  if (!parsed.ok) return { ok: false, reason: 'inventory-invalid' }
  if (
    parsed.value.kind === 'review-attempt' &&
    parsed.value.payload.stage === 'initial' &&
    parsed.value.payload.purpose === 'review' &&
    parsed.value.payload.inputSnapshot.manifest.expandedContext.length > 0
  ) {
    if (successorTaskMismatch(input.prepared, parsed.value))
      return { ok: false, reason: 'review-successor-task-mismatch' }
    if (!authorizeReviewContextSuccessor(await input.readHistory(), parsed.value))
      return { ok: false, reason: 'review-successor-unauthorized' }
  }
  if (input.initialInventoryId === parsed.value.recordId) {
    if (!input.inventories.includes(parsed.value.recordId)) input.inventories.push(parsed.value.recordId)
    return { ok: true }
  }
  const saved = await input.publish(parsed.value)
  if (!saved.ok) return { ok: false, reason: saved.diagnostics.join(',') }
  if (
    parsed.value.kind === 'review-attempt' &&
    parsed.value.payload.stage === 'initial' &&
    parsed.value.payload.purpose === 'review' &&
    parsed.value.payload.inputSnapshot.manifest.expandedContext.length > 0 &&
    !authorizeReviewContextSuccessor(await input.readHistory(), parsed.value)
  )
    return { ok: false, reason: 'review-successor-unauthorized' }
  input.inventories.push(parsed.value.recordId)
  return { ok: true }
}
