import { missingContextOf } from './action-context.ts'
import { canonicalValueDigest } from './action-input.ts'
import { inspectNativeTerminal } from './native-terminal.ts'
import { producerOutputValid } from './producer-schema.ts'
import { workflowContextNegative } from './workflow-context-output.ts'
import { reviewChildValid } from './workflow-context-review.ts'
import type { ReceiptRecord } from './workflow-control.ts'

const equal = (a: unknown, b: unknown) => canonicalValueDigest(a) === canonicalValueDigest(b)

/** A projected negative can waive a hold only when its conserved native terminal agrees. */
export function contextNativeNegativeValid(record: ReceiptRecord): boolean {
  const payload = record.payload
  if (
    payload.phase !== 'result' ||
    payload.native.completion !== 'completed' ||
    payload.native.strict !== 'valid' ||
    !workflowContextNegative(record)
  )
    return false
  if (payload.action === 'plan-review') {
    return (
      payload.contributions.some(
        (contribution) =>
          missingContextOf(contribution.structured) !== null && equal(contribution.structured, payload.structured),
      ) && reviewContributionsValid(payload)
    )
  }
  const terminal = inspectNativeTerminal(payload.native.raw)
  return terminal.reason === null && equal(terminal.structured, payload.structured)
}

function reviewContributionsValid(
  payload: Extract<ReceiptRecord['payload'], { action: 'plan-review'; phase: 'result' }>,
): boolean {
  const slots = new Set<string>()
  const children = new Set<string>()
  for (const contribution of payload.contributions) {
    const slot = payload.slots.find((item) => item.slotId === contribution.host.slotId)
    const child = contribution.host.childId
    if (
      slot === undefined ||
      slots.has(slot.slotId) ||
      child === null ||
      children.has(child) ||
      !reviewChildValid(slot, contribution) ||
      contribution.native === null
    )
      return false
    slots.add(slot.slotId)
    children.add(child)
    const terminal = inspectNativeTerminal(contribution.native.raw)
    const raw = contribution.native.raw
    const last = contribution.rawAttempts.at(-1)
    if (
      terminal.reason !== null ||
      !producerOutputValid('plan-review', terminal.structured) ||
      !equal(terminal.structured, contribution.structured) ||
      raw === null ||
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      raw.id !== child ||
      last === undefined ||
      last.raw === null ||
      !equal(last.data, contribution.structured)
    )
      return false
    const yielded = last.raw
    if (
      typeof yielded !== 'object' ||
      Array.isArray(yielded) ||
      yielded === null ||
      typeof yielded.executionArguments !== 'object' ||
      yielded.executionArguments === null ||
      Array.isArray(yielded.executionArguments) ||
      !equal(yielded.executionArguments.data, last.data)
    )
      return false
  }
  return true
}
