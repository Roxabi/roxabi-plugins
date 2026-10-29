import { missingContextOf } from './action-context.ts'
import { canonicalValueDigest, validateActionInputs } from './action-input.ts'
import { producerOutputValid } from './producer-schema.ts'
import type { Contribution } from './record-values.ts'
import type { ReceiptRecord } from './workflow-control.ts'
import type { PlanReviewSlot } from './workflow-receipt-schema.ts'

export function reviewContextPairValid(start: ReceiptRecord, result: ReceiptRecord, negative: boolean): boolean {
  const payload = result.payload
  if (payload.action !== 'plan-review' || payload.phase !== 'result') return true
  if (start.payload.action !== 'plan-review' || start.payload.phase !== 'start') return false
  if (canonicalValueDigest(start.payload.slots) !== canonicalValueDigest(payload.slots)) return false
  if (!negative) return true
  const negatives = payload.contributions.filter(
    (contribution) =>
      producerOutputValid('plan-review', contribution.structured) && missingContextOf(contribution.structured) !== null,
  )
  const contribution = negatives[0]
  if (negatives.length !== 1 || contribution === undefined) return false
  if (
    !reviewChildValid(
      payload.slots.find((item) => item.slotId === contribution.host.slotId),
      contribution,
    )
  )
    return false
  return (
    payload.structured === null ||
    canonicalValueDigest(contribution.structured) === canonicalValueDigest(payload.structured)
  )
}

function reviewChildValid(slot: PlanReviewSlot | undefined, contribution: Contribution): boolean {
  if (slot?.action == null || contribution.host.action == null) return false
  if (contribution.host.origin !== 'native' || contribution.host.role !== slot.specialist) return false
  if (contribution.native?.completion !== 'completed' || contribution.native.strict !== 'valid') return false
  return (
    validateActionInputs(slot.action.inputs).ok &&
    canonicalValueDigest(slot.action) === canonicalValueDigest(contribution.host.action)
  )
}
