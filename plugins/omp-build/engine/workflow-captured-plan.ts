import { canonicalValueDigest } from './action-input.ts'
import { assessPlanCoverage } from './criterion-admission.ts'
import type { DecodedHistory } from './history-schema.ts'
import { inspectNativeTerminal } from './native-terminal.ts'
import { producerOutputValid } from './producer-schema.ts'
import { diagnostic, equalScope, sameRef } from './record-diagnostics.ts'
import type { Result } from './result.ts'
import type { CapturedInvocation } from './workflow-captured-inventory.ts'
import { inspectPlanSpecialists, planPinMatches } from './workflow-captured-plan-specialists.ts'
import { workflowContextNegative } from './workflow-context-terminal.ts'
import type { ReceiptRecord } from './workflow-control.ts'
import { planDigest, planOutputSchema } from './workflow-output-schema.ts'
import { assessBoundPlanAmendment, assessBoundPlanReview } from './workflow-plan-macro.ts'
import type { AssessmentReplayContext } from './workflow-spec-authentication.ts'

function isReviewResult(record: ReceiptRecord): record is ReceiptRecord & {
  payload: Extract<ReceiptRecord['payload'], { action: 'plan-review'; phase: 'result' }>
} {
  return record.payload.action === 'plan-review' && record.payload.phase === 'result'
}

export function sameCapturedAuthority(left: CapturedInvocation, right: CapturedInvocation): boolean {
  const a = left.result.payload.inputs.manifest.subject
  const b = right.result.payload.inputs.manifest.subject
  const leftMandate = left.result.payload.mandate
  const rightMandate = right.result.payload.mandate
  return (
    a.kind === 'uw' &&
    b.kind === 'uw' &&
    equalScope(a.uw, b.uw) &&
    'scope' in leftMandate &&
    'scope' in rightMandate &&
    sameRef(leftMandate, rightMandate) &&
    canonicalValueDigest(left.frame.prefix) === canonicalValueDigest(right.frame.prefix) &&
    canonicalValueDigest(left.result.payload.inputs.manifest.spec) ===
      canonicalValueDigest(right.result.payload.inputs.manifest.spec)
  )
}

function fail(message: string): Result<never> {
  return { ok: false, diagnostics: [diagnostic('unconfirmed', message)] }
}

type PlanPayload = Extract<ReceiptRecord['payload'], { action: 'plan'; phase: 'result' }>
type ReviewPayload = Extract<ReceiptRecord['payload'], { action: 'plan-review'; phase: 'result' }>
type AcceptedSpec = Extract<PlanPayload['inputs']['manifest']['spec'], { kind: 'accepted' }>

function inspectAmendment(
  item: CapturedInvocation,
  payload: PlanPayload,
  spec: AcceptedSpec,
  invocations: readonly CapturedInvocation[],
): Result<void> {
  const reviews = invocations.filter(
    (candidate) =>
      isReviewResult(candidate.result) &&
      candidate.result.payload.actionId === payload.exactInputs.amendsReviewActionId &&
      sameCapturedAuthority(item, candidate) &&
      !workflowContextNegative(candidate.result),
  )
  const review = reviews[0]?.result
  if (reviews.length !== 1 || review === undefined || !isReviewResult(review))
    return fail('Captured amendment does not identify one bound review')
  const drafts = invocations.filter(
    (candidate) =>
      candidate.result.payload.action === 'plan' &&
      candidate.result.payload.phase === 'result' &&
      candidate.result.payload.actionId === review.payload.exactInputs.draftActionId &&
      sameCapturedAuthority(item, candidate) &&
      !workflowContextNegative(candidate.result),
  )
  const draft = drafts[0]
  if (drafts.length !== 1 || draft === undefined || !planPinMatches(payload.inputs, draft.result))
    return fail('Captured amendment does not bind its review draft')
  const judgment = assessBoundPlanReview(review, spec.effective)
  if (!judgment.ok) return judgment
  const valid = assessBoundPlanAmendment({ ...item.result, payload }, spec.effective, judgment.value.blockers)
  if (!valid.ok) return valid
  return { ok: true, value: undefined }
}

function inspectPlan(
  item: CapturedInvocation,
  payload: PlanPayload,
  spec: AcceptedSpec,
  invocations: readonly CapturedInvocation[],
): Result<void> {
  const terminal = inspectNativeTerminal(payload.native.raw)
  if (
    terminal.reason !== null ||
    !producerOutputValid('plan', terminal.structured) ||
    canonicalValueDigest(terminal.structured) !== canonicalValueDigest(payload.structured)
  )
    return fail('Captured plan output differs from its actual native terminal')
  if (workflowContextNegative(item.result)) return { ok: true, value: undefined }
  const plan = planOutputSchema.safeParse(payload.structured)
  if (!plan.success) return fail('Captured plan result is malformed')
  const coverage = assessPlanCoverage({ spec: spec.effective, plan: plan.data })
  if (!coverage.ok) return coverage
  if (payload.exactInputs.amendsReviewActionId === null) {
    if (payload.exactInputs.requiredBlockers.length || plan.data.resolutions.length)
      return fail('Captured draft contains amendment resolutions')
    return { ok: true, value: undefined }
  }
  return inspectAmendment(item, payload, spec, invocations)
}

function inspectReview(
  item: CapturedInvocation,
  payload: ReviewPayload,
  spec: AcceptedSpec,
  invocations: readonly CapturedInvocation[],
  histories: readonly DecodedHistory[],
  replay?: AssessmentReplayContext,
): Result<void> {
  const drafts = invocations.filter(
    (candidate) =>
      candidate.result.payload.action === 'plan' &&
      candidate.result.payload.phase === 'result' &&
      candidate.result.payload.actionId === payload.exactInputs.draftActionId &&
      sameCapturedAuthority(item, candidate) &&
      !workflowContextNegative(candidate.result),
  )
  const draft = drafts[0]?.result
  if (
    drafts.length !== 1 ||
    draft?.payload.action !== 'plan' ||
    draft.payload.phase !== 'result' ||
    draft.payload.exactInputs.amendsReviewActionId !== null ||
    !planPinMatches(payload.inputs, draft)
  )
    return fail('Captured review does not bind one exact draft')
  const plan = planOutputSchema.safeParse(draft.payload.structured)
  if (!plan.success || planDigest(plan.data) !== payload.exactInputs.planDigest)
    return fail('Captured review plan digest differs from its draft')
  const specialists = inspectPlanSpecialists(item, payload, draft, histories, replay)
  if (!specialists.ok) return specialists
  if (workflowContextNegative(item.result)) return { ok: true, value: undefined }
  if (payload.contributions.length !== payload.slots.length)
    return fail('Captured plan review has an absent specialist judgment')
  const judgment = assessBoundPlanReview({ ...item.result, payload }, spec.effective)
  if (!judgment.ok) return judgment
  return { ok: true, value: undefined }
}

/** Account plan work in the frame it actually captured; this does not select an eligible current plan. */
export function inspectCapturedPlans(
  invocations: readonly CapturedInvocation[],
  histories: readonly DecodedHistory[],
  replay?: AssessmentReplayContext,
): Result<void> {
  for (const item of invocations) {
    const payload = item.result.payload
    if (payload.phase !== 'result' || (payload.action !== 'plan' && payload.action !== 'plan-review')) continue
    const spec = payload.inputs.manifest.spec
    if (
      spec.kind !== 'accepted' ||
      payload.exactInputs.mandateId !== item.frame.mandate.recordId ||
      payload.exactInputs.specDigest !== spec.effective.own.version
    )
      return fail('Captured plan identity differs from its authenticated frame')
    const result =
      payload.action === 'plan'
        ? inspectPlan(item, payload, spec, invocations)
        : inspectReview(item, payload, spec, invocations, histories, replay)
    if (!result.ok) return result
  }
  return { ok: true, value: undefined }
}

/** Resolve a downstream invocation's exact captured plan dependency, never today's eligible plan. */
export function capturedPlanForInvocation(
  item: CapturedInvocation,
  invocations: readonly CapturedInvocation[],
): Result<CapturedInvocation> {
  const payload = item.result.payload
  if (payload.phase !== 'result' || (payload.action !== 'implement' && payload.action !== 'integrate'))
    return fail('Captured delivery has no implementation plan identity')
  const candidates = invocations.filter(
    (candidate) =>
      candidate.result.payload.action === 'plan' &&
      candidate.result.payload.phase === 'result' &&
      candidate.result.payload.actionId === payload.exactInputs.planActionId &&
      sameCapturedAuthority(item, candidate) &&
      planPinMatches(payload.inputs, candidate.result) &&
      !workflowContextNegative(candidate.result),
  )
  const selected = candidates[0]
  if (
    candidates.length !== 1 ||
    selected?.result.payload.action !== 'plan' ||
    selected.result.payload.phase !== 'result'
  )
    return fail('Captured delivery does not select one exact plan in its accepted frame')
  const amendment = selected.result.payload.exactInputs.amendsReviewActionId
  const reviews = invocations.filter(
    (candidate) =>
      isReviewResult(candidate.result) &&
      sameCapturedAuthority(selected, candidate) &&
      !workflowContextNegative(candidate.result) &&
      (amendment === null
        ? candidate.result.payload.exactInputs.draftActionId === selected.result.payload.actionId
        : candidate.result.payload.actionId === amendment),
  )
  const review = reviews[0]?.result
  const spec = payload.inputs.manifest.spec
  if (reviews.length !== 1 || review === undefined || !isReviewResult(review) || spec.kind !== 'accepted')
    return fail('Captured delivery plan has no unique bound specialist review')
  const judgment = assessBoundPlanReview(review, spec.effective)
  if (!judgment.ok) return judgment
  if (judgment.value.clear !== (amendment === null))
    return fail('Captured delivery selected a draft or amendment inconsistent with its review')
  if (amendment !== null) {
    const amendments = invocations.filter(
      (candidate) =>
        candidate.result.payload.action === 'plan' &&
        candidate.result.payload.phase === 'result' &&
        candidate.result.payload.exactInputs.amendsReviewActionId === amendment &&
        sameCapturedAuthority(selected, candidate) &&
        !workflowContextNegative(candidate.result),
    )
    if (amendments.length !== 1) return fail('Captured delivery amendment is ambiguous')
  }
  return { ok: true, value: selected }
}
