import { canonicalValueDigest } from './action-input.ts'
import type { ActionInputs } from './action-input-schema.ts'
import type { DecodedHistory } from './history-schema.ts'
import { inspectNativeTerminal } from './native-terminal.ts'
import { producerOutputValid } from './producer-schema.ts'
import { diagnostic, sameRef } from './record-diagnostics.ts'
import type { Result } from './result.ts'
import { authenticateCapturedWorkFrame } from './workflow-captured-frame.ts'
import type { CapturedInvocation } from './workflow-captured-inventory.ts'
import { reviewChildValid } from './workflow-context-review.ts'
import type { ReceiptRecord } from './workflow-control.ts'
import { PLAN_REVIEW_SPECIALISTS } from './workflow-receipt-schema.ts'
import type { AssessmentReplayContext } from './workflow-spec-authentication.ts'

type ReviewPayload = Extract<ReceiptRecord['payload'], { action: 'plan-review'; phase: 'result' }>

function fail(message: string): Result<never> {
  return { ok: false, diagnostics: [diagnostic('unconfirmed', message)] }
}

export function planPinMatches(inputs: ActionInputs, plan: ReceiptRecord): boolean {
  const pins = inputs.manifest.deliveryData.filter((pin) => pin.role === 'plan')
  const pin = pins[0]
  return (
    pins.length === 1 &&
    pin !== undefined &&
    pin.selector === '/payload/structured' &&
    sameRef(pin.record, {
      scope: { repository: plan.repository, target: plan.target },
      kind: 'action-receipt',
      recordId: plan.recordId,
    }) &&
    plan.payload.phase === 'result' &&
    pin.digest === canonicalValueDigest(plan.payload.structured)
  )
}

function inspectActions(
  item: CapturedInvocation,
  payload: ReviewPayload,
  draft: ReceiptRecord,
  histories: readonly DecodedHistory[],
  replay?: AssessmentReplayContext,
): Result<void> {
  if (
    payload.slots.length !== PLAN_REVIEW_SPECIALISTS.length ||
    PLAN_REVIEW_SPECIALISTS.some((role) => payload.slots.filter((slot) => slot.specialist === role).length !== 1)
  )
    return fail('Captured plan review lacks its exact declared specialist slots')
  const actionIds = new Set<string>()
  for (const slot of payload.slots) {
    const action = slot.action
    if (
      action === undefined ||
      actionIds.has(action.actionId) ||
      action.inputs.manifest.purpose !== 'plan-review' ||
      action.inputs.manifest.code.referenceCommit !== action.inputs.manifest.code.base ||
      canonicalValueDigest(action.inputs.manifest.code) !== canonicalValueDigest(payload.inputs.manifest.code) ||
      !planPinMatches(action.inputs, draft)
    )
      return fail('Captured specialist action does not bind the exact declared review')
    actionIds.add(action.actionId)
    const frame = authenticateCapturedWorkFrame(action.inputs, payload.mandate, histories, replay)
    if (!frame.ok) return frame
    if (
      canonicalValueDigest(frame.value.prefix) !== canonicalValueDigest(item.frame.prefix) ||
      canonicalValueDigest(action.inputs.manifest.spec) !== canonicalValueDigest(payload.inputs.manifest.spec)
    )
      return fail('Captured specialist used a different accepted frame')
  }
  return { ok: true, value: undefined }
}

function inspectContributions(payload: ReviewPayload): Result<void> {
  const slots = new Set<string>()
  const children = new Set<string>()
  for (const contribution of payload.contributions) {
    const slot = payload.slots.find((candidate) => candidate.slotId === contribution.host.slotId)
    const child = contribution.host.childId
    if (
      slot === undefined ||
      slots.has(slot.slotId) ||
      child === null ||
      children.has(child) ||
      !reviewChildValid(slot, contribution) ||
      contribution.native === null
    )
      return fail('Captured specialist contribution is not uniquely authenticated')
    slots.add(slot.slotId)
    children.add(child)
    const terminal = inspectNativeTerminal(contribution.native.raw)
    const raw = contribution.native.raw
    const last = contribution.rawAttempts.at(-1)
    if (
      terminal.reason !== null ||
      !producerOutputValid('plan-review', terminal.structured) ||
      canonicalValueDigest(terminal.structured) !== canonicalValueDigest(contribution.structured) ||
      raw === null ||
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      raw.id !== child ||
      last === undefined ||
      last.raw === null ||
      canonicalValueDigest(last.data) !== canonicalValueDigest(contribution.structured)
    )
      return fail('Captured specialist terminal and submitted judgment disagree')
    const yieldRaw = last.raw
    if (
      typeof yieldRaw !== 'object' ||
      Array.isArray(yieldRaw) ||
      yieldRaw === null ||
      typeof yieldRaw.executionArguments !== 'object' ||
      yieldRaw.executionArguments === null ||
      Array.isArray(yieldRaw.executionArguments) ||
      canonicalValueDigest(yieldRaw.executionArguments.data) !== canonicalValueDigest(last.data)
    )
      return fail('Captured specialist submission differs from its raw yield')
  }
  return { ok: true, value: undefined }
}

export function inspectPlanSpecialists(
  item: CapturedInvocation,
  payload: ReviewPayload,
  draft: ReceiptRecord,
  histories: readonly DecodedHistory[],
  replay?: AssessmentReplayContext,
): Result<void> {
  const actions = inspectActions(item, payload, draft, histories, replay)
  if (!actions.ok) return actions
  return inspectContributions(payload)
}
