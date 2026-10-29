import { isDeepStrictEqual } from 'node:util'
import type { ActionInputs } from '../engine/action-input-schema.ts'
import type { PlanReviewSlot } from '../engine/workflow-receipt-schema.ts'
import type { NativeChildResult } from '../omp/review-runtime/contracts.ts'

/** A negative is authoritative only for the sealed action that actually ran. */
export function matchesContextNegative(child: NativeChildResult, actionId: string, inputs: ActionInputs): boolean {
  return (
    child.contextBlock !== undefined &&
    child.contextBlock.action.actionId === actionId &&
    isDeepStrictEqual(child.contextBlock.action.inputs, inputs)
  )
}

export function matchesPlanReviewNegative(child: NativeChildResult, slots: readonly PlanReviewSlot[]): boolean {
  const slot = slots.find((entry) => entry.slotId === child.expectedId)
  return slot?.action !== undefined && matchesContextNegative(child, slot.action.actionId, slot.action.inputs)
}
