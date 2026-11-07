import { assessPlanCoverage } from './criterion-admission.ts'
import { uniqueAccounted } from './delivery-eligibility.ts'
import { diagnostic } from './record-diagnostics.ts'
import type { Diagnostic } from './record-values.ts'
import type { Result } from './result.ts'
import { resolveSpecEffective } from './spec-effective.ts'
import type { SpecEffective } from './spec-effective-schema.ts'
import { toDiagnostics } from './uw-diagnostics.ts'
import { resolveAcceptedSpec } from './workflow-accepted-spec.ts'
import type { MandateRecord, ReceiptRecord } from './workflow-control.ts'
import { type PlanBlockerRef, type PlanOutput, planOutputSchema, planReviewSchema } from './workflow-output-schema.ts'
import type { PlanMacro, WorkflowEvidence } from './workflow-plan.ts'
import {
  type EmptyMacro,
  type PlanResultReceipt,
  type PlanReviewReceipt,
  prepareReview,
  type ReviewContext,
} from './workflow-plan-review-selection.ts'
import { PLAN_REVIEW_SPECIALISTS } from './workflow-receipt-schema.ts'
import type { AssessmentReplayContext } from './workflow-spec-authentication.ts'

export function planMacro(
  evidence: WorkflowEvidence,
  mandate: MandateRecord | null,
  options?: { contextLeaf?: ReceiptRecord; assessmentReplay?: AssessmentReplayContext },
): PlanMacro {
  const empty = emptyMacro(mandate, null)
  if (mandate === null) return empty('blocked', [diagnostic('mandate-absent', 'plan macro has no mandate')])
  const accepted = resolveAcceptedSpec(mandate, evidence.causal.histories, options?.assessmentReplay)
  if (!accepted.ok) return empty('blocked', accepted.evidence)
  const effective = resolveSpecEffective({
    mode: 'current',
    own: accepted.spec.ref,
    histories: evidence.causal.histories,
    graph: evidence.causal.observation.graph,
  })
  if (!effective.ok) return empty('blocked', toDiagnostics(effective.diagnostics))
  const acceptedEmpty = emptyMacro(mandate, effective.value.own.version)
  const reviewContext = prepareReview(
    evidence,
    mandate,
    accepted.spec,
    effective.value,
    acceptedEmpty,
    options?.contextLeaf,
  )
  if ('macro' in reviewContext) return reviewContext.macro
  return evaluateReview(reviewContext, acceptedEmpty)
}

function emptyMacro(mandate: MandateRecord | null, specDigest: string | null): EmptyMacro {
  return (phase, evidence, extra = {}) => ({
    phase,
    mandateId: mandate?.recordId ?? null,
    specDigest,
    draftActionId: null,
    reviewActionId: null,
    amendmentActionId: null,
    blockers: [],
    evidence,
    ...extra,
  })
}

function evaluateReview(context: ReviewContext, empty: EmptyMacro): PlanMacro {
  const { latest, review, results } = context
  const identity = { draftActionId: latest.payload.actionId, reviewActionId: review.payload.actionId }
  const judgment = assessBoundPlanReview(review, context.accepted)
  if (!judgment.ok) return empty('blocked', judgment.diagnostics, identity)
  const refs = { refs: judgment.value.blockers }
  if (judgment.value.clear) return empty('eligible', [], identity)
  const amendments = uniqueAccounted(
    results.filter((record) => record.payload.exactInputs.amendsReviewActionId === review.payload.actionId),
    'plan amendment',
  )
  if (!amendments.ok) return empty('blocked', amendments.diagnostics, identity)
  const amendment = amendments.value
  if (amendment === null) {
    return empty('needs-amendment', [diagnostic('needs-amendment', 'blocking review has no amendment')], {
      ...identity,
      blockers: refs.refs,
    })
  }
  const valid = assessBoundPlanAmendment(amendment, context.accepted, refs.refs)
  if (!valid.ok)
    return empty('blocked', valid.diagnostics, {
      amendmentActionId: amendment.payload.actionId,
      blockers: refs.refs,
    })
  return empty('eligible', [], { ...identity, amendmentActionId: amendment.payload.actionId, blockers: refs.refs })
}

function reviewSlotStatus(review: PlanReviewReceipt): 'valid' | 'invalid' | 'missing' {
  const declaredSlots = new Set(review.payload.slots.map((slot) => slot.slotId))
  const coveredSlots = new Set<string>()
  for (const contribution of review.payload.contributions) {
    const parsed = planReviewSchema.safeParse(contribution.structured)
    if (!parsed.success || contribution.host.slotId === null || !declaredSlots.has(contribution.host.slotId))
      return 'invalid'
    coveredSlots.add(contribution.host.slotId)
  }
  return [...declaredSlots].some((slotId) => !coveredSlots.has(slotId)) ? 'missing' : 'valid'
}

export function reviewBlockerRefs(
  review: PlanReviewReceipt,
  acceptedIds: ReadonlySet<string>,
): { ok: true; refs: PlanBlockerRef[] } | { ok: false; evidence: Diagnostic[] } {
  const refs: PlanBlockerRef[] = []
  for (const contribution of review.payload.contributions) {
    const parsed = planReviewSchema.safeParse(contribution.structured)
    if (!parsed.success)
      return { ok: false, evidence: [diagnostic('ambiguous', 'specialist plan review is not a unique review')] }
    if (parsed.data.outcome !== 'blocking') continue
    if (contribution.host.slotId === null)
      return { ok: false, evidence: [diagnostic('malformed', 'blocking review has no slot')] }
    for (const blocker of parsed.data.blockers) {
      if (!acceptedIds.has(blocker.criterionId)) {
        return {
          ok: false,
          evidence: [diagnostic('unknown-reference', `Plan blocker cites unknown criterion ${blocker.criterionId}`)],
        }
      }
      refs.push({
        sourceId: contribution.host.childId ?? contribution.host.slotId,
        slotId: contribution.host.slotId,
        blockerId: blocker.id,
      })
    }
  }
  return { ok: true, refs }
}

export function sameBlockerSet(left: readonly PlanBlockerRef[], right: readonly PlanBlockerRef[]): boolean {
  return (
    left.length === right.length &&
    left.every((item) =>
      right.some(
        (other) =>
          item.sourceId === other.sourceId && item.slotId === other.slotId && item.blockerId === other.blockerId,
      ),
    )
  )
}

/** Pure semantics of an already-bound review, shared with captured invocation accounting. */
export function assessBoundPlanReview(
  review: PlanReviewReceipt,
  accepted: SpecEffective,
): Result<{ clear: boolean; blockers: PlanBlockerRef[] }> {
  const specialists = new Set(review.payload.slots.map((slot) => slot.specialist))
  if (PLAN_REVIEW_SPECIALISTS.some((name) => !specialists.has(name)))
    return {
      ok: false,
      diagnostics: [diagnostic('missing-contribution', 'plan review does not declare both specialists')],
    }
  const status = reviewSlotStatus(review)
  if (status !== 'valid')
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          'missing-contribution',
          status === 'missing' ? 'plan review slot has no review' : 'plan review contribution is not a review',
        ),
      ],
    }
  const refs = reviewBlockerRefs(review, new Set(accepted.spec.criteria.map((item) => item.id)))
  if (!refs.ok) return { ok: false, diagnostics: refs.evidence }
  const clear =
    review.payload.contributions.length > 0 &&
    review.payload.contributions.every((contribution) => {
      const parsed = planReviewSchema.safeParse(contribution.structured)
      return parsed.success && parsed.data.outcome === 'clear'
    })
  return { ok: true, value: { clear, blockers: refs.refs } }
}

/** Pure semantics of an already-bound amendment; this does not select an eligible plan. */
export function assessBoundPlanAmendment(
  amendment: PlanResultReceipt,
  accepted: SpecEffective,
  blockers: readonly PlanBlockerRef[],
): Result<PlanOutput> {
  const parsed = planOutputSchema.safeParse(amendment.payload.structured)
  if (!parsed.success) return { ok: false, diagnostics: [diagnostic('malformed', 'amendment is not a plan')] }
  if (
    !sameBlockerSet(amendment.payload.exactInputs.requiredBlockers, blockers) ||
    !sameBlockerSet(
      parsed.data.resolutions.map((resolution) => resolution.blocker),
      blockers,
    )
  )
    return {
      ok: false,
      diagnostics: [diagnostic('missing-contribution', 'amendment resolutions do not cover the review refs')],
    }
  const coverage = assessPlanCoverage({ spec: accepted, plan: parsed.data })
  return coverage.ok ? { ok: true, value: parsed.data } : coverage
}
