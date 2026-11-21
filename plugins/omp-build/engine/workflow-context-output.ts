import { missingContextOf } from './action-context.ts'
import { producerOutputValid } from './producer-schema.ts'
import { integrationOutputSchema } from './uw-integration-schema.ts'
import type { ReceiptRecord } from './workflow-control.ts'
import { implementationOutputSchema } from './workflow-output-schema.ts'

const outputFor = {
  frame: 'spec',
  plan: 'plan',
  'assess-spec': 'spec-assessment',
  'attribute-ci': 'ci-attribution',
  implement: 'delivery-execution',
  integrate: 'delivery-execution',
} as const

export function workflowContextNegative(result: ReceiptRecord): boolean {
  const payload = result.payload
  if (payload.phase !== 'result') return false
  if (payload.action === 'plan-review') {
    return (
      (producerOutputValid('plan-review', payload.structured) && missingContextOf(payload.structured) !== null) ||
      payload.contributions.some(
        (contribution) =>
          producerOutputValid('plan-review', contribution.structured) &&
          missingContextOf(contribution.structured) !== null,
      )
    )
  }
  if (!(payload.action in outputFor)) return false
  const output = outputFor[payload.action as keyof typeof outputFor]
  return (
    (producerOutputValid(output, payload.structured) ||
      (payload.action === 'implement' && implementationOutputSchema.safeParse(payload.structured).success)) &&
    missingContextOf(payload.structured) !== null
  )
}

export function validPositiveSuccessor(successor: ReceiptRecord): boolean {
  const payload = successor.payload
  if (payload.phase !== 'result') return false
  if (payload.action === 'plan-review') return positiveReviewSuccessor(payload)
  if (payload.action === 'implement') {
    const parsed = implementationOutputSchema.safeParse(payload.structured)
    return (
      parsed.success &&
      parsed.data.outcome === 'implemented' &&
      payload.admission?.admitted === true &&
      payload.admission.remoteTip !== null
    )
  }
  if (payload.action === 'integrate')
    return (
      integrationOutputSchema.safeParse(payload.structured).success &&
      payload.admission?.admitted === true &&
      payload.admission.remoteTip !== null
    )
  if (payload.action === 'frame' && payload.structured === null) return true
  if (!(payload.action in outputFor)) return true
  const output = outputFor[payload.action as keyof typeof outputFor]
  return producerOutputValid(output, payload.structured)
}

function positiveReviewSuccessor(
  payload: Extract<ReceiptRecord['payload'], { action: 'plan-review'; phase: 'result' }>,
): boolean {
  return (
    payload.slots.every((slot) => {
      const contributions = payload.contributions.filter((contribution) => contribution.host.slotId === slot.slotId)
      const contribution = contributions[0]
      return (
        contributions.length === 1 &&
        contribution !== undefined &&
        producerOutputValid('plan-review', contribution.structured) &&
        missingContextOf(contribution.structured) === null
      )
    }) && payload.contributions.length === payload.slots.length
  )
}
