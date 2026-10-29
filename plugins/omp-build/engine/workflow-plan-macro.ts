import { missingContextOf } from './action-context.ts'
import { assessPlanCoverage } from './criterion-admission.ts'
import { nativeResultValid, uniqueAccounted } from './delivery-eligibility.ts'
import type { DecodedHistory } from './history-schema.ts'
import { producerOutputValid } from './producer-schema.ts'
import { diagnostic, sameRef } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { Diagnostic } from './record-values.ts'
import type { SpecEffective } from './spec-effective.ts'
import { resolveOwnSpecEffective } from './spec-effective.ts'
import { resolveAcceptedSpec } from './workflow-accepted-spec.ts'
import { workflowContextTerminal } from './workflow-context-terminal.ts'
import { type MandateRecord, mandateScope, type ReceiptRecord, recordsOf } from './workflow-control.ts'
import { type PlanBlockerRef, planDigest, planOutputSchema, planReviewSchema } from './workflow-output-schema.ts'
import type { PlanMacro, PlanMacroPhase, WorkflowEvidence } from './workflow-plan.ts'
import { PLAN_REVIEW_SPECIALISTS } from './workflow-receipt-schema.ts'
import type { AssessmentReplayContext } from './workflow-spec-authentication.ts'

type EmptyMacro = (phase: PlanMacroPhase, evidence: Diagnostic[], extra?: Partial<PlanMacro>) => PlanMacro
type PlanResultReceipt = ReceiptRecord & {
  payload: Extract<ReceiptRecord['payload'], { action: 'plan'; phase: 'result' }>
}
type PlanReviewReceipt = ReceiptRecord & {
  payload: Extract<ReceiptRecord['payload'], { action: 'plan-review'; phase: 'result' }>
}
type ReviewContext = {
  latest: PlanResultReceipt
  review: PlanReviewReceipt
  results: PlanResultReceipt[]
  accepted: SpecEffective
}

export function planMacro(
  evidence: WorkflowEvidence,
  mandate: MandateRecord | null,
  options?: { contextLeaf?: ReceiptRecord; assessmentReplay?: AssessmentReplayContext },
): PlanMacro {
  const empty = emptyMacro(mandate, null)
  if (mandate === null) return empty('blocked', [diagnostic('mandate-absent', 'plan macro has no mandate')])
  const accepted = resolveAcceptedSpec(
    mandate,
    [evidence.issue, ...(evidence.pullRequest === null ? [] : [evidence.pullRequest]), ...evidence.parents],
    options?.assessmentReplay,
  )
  if (!accepted.ok) return empty('blocked', accepted.evidence)
  const effective = resolveOwnSpecEffective(accepted.spec)
  if (!effective.ok) return empty('blocked', effective.diagnostics)
  const acceptedEmpty = emptyMacro(mandate, effective.value.own.version)
  const reviewContext = prepareReview(evidence.issue, mandate, effective.value, acceptedEmpty, options?.contextLeaf)
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

function prepareReview(
  history: DecodedHistory,
  mandate: MandateRecord,
  accepted: SpecEffective,
  empty: EmptyMacro,
  contextLeaf?: ReceiptRecord,
): ReviewContext | { macro: PlanMacro } {
  for (const action of ['plan', 'plan-review'] as const) {
    const terminal = workflowContextTerminal(history, action, contextLeaf)
    if (terminal === 'missing')
      return { macro: empty('blocked', [diagnostic('action-context-missing', `${action} requires expanded context`)]) }
    if (terminal === 'uncertain')
      return {
        macro: empty('uncertain', [diagnostic('action-uncertain', `${action} context result is not authenticated`)]),
      }
    if (terminal === 'ambiguous')
      return { macro: empty('blocked', [diagnostic('ambiguous', `${action} context result has competing successors`)]) }
  }
  const starts = receiptsFor(history, 'plan', 'start')
  const results = planResults(history).filter(
    (record) =>
      planMatchesMandate(record, mandate, accepted.own.version) &&
      !(producerOutputValid('plan', record.payload.structured) && missingContextOf(record.payload.structured) !== null),
  )
  if (
    starts.some((start) => !planResults(history).some((result) => result.payload.actionId === start.payload.actionId))
  ) {
    return { macro: empty('uncertain', [diagnostic('action-uncertain', 'plan start has no result')]) }
  }
  if (
    receiptsFor(history, 'plan-review', 'start').some(
      (start) => !planReviews(history).some((result) => result.payload.actionId === start.payload.actionId),
    )
  ) {
    return { macro: empty('uncertain', [diagnostic('action-uncertain', 'plan review start has no result')]) }
  }
  const drafts = uniqueAccounted(
    results.filter((record) => record.payload.exactInputs.amendsReviewActionId === null),
    'current plan draft',
  )
  if (!drafts.ok) return { macro: empty('blocked', drafts.diagnostics) }
  const latest = drafts.value
  if (latest === null) {
    return { macro: empty('needs-draft', [diagnostic('needs-draft', 'no plan result is bound to the mandate spec')]) }
  }
  const parsedPlan = planOutputSchema.safeParse(latest.payload.structured)
  if (!parsedPlan.success) return { macro: empty('blocked', [diagnostic('malformed', 'plan result is not a plan')]) }
  const coverage = assessPlanCoverage({ spec: accepted, plan: parsedPlan.data })
  if (!coverage.ok) return { macro: empty('blocked', coverage.diagnostics) }
  const review = matchingReview(history, mandate, latest, planDigest(parsedPlan.data))
  if (!review.ok) return { macro: empty('blocked', review.diagnostics) }
  if (review.value === null) {
    return {
      macro: empty('needs-review', [diagnostic('needs-review', 'plan has no matching review')], {
        draftActionId: latest.payload.actionId,
      }),
    }
  }
  return { latest, review: review.value, results, accepted }
}

function evaluateReview(context: ReviewContext, empty: EmptyMacro): PlanMacro {
  const { latest, review, results } = context
  const identity = { draftActionId: latest.payload.actionId, reviewActionId: review.payload.actionId }
  const specialists = new Set(review.payload.slots.map((slot) => slot.specialist))
  if (PLAN_REVIEW_SPECIALISTS.some((name) => !specialists.has(name))) {
    return empty('blocked', [diagnostic('missing-contribution', 'plan review does not declare both specialists')])
  }
  const slotStatus = reviewSlotStatus(review)
  if (slotStatus === 'invalid') {
    return empty('blocked', [diagnostic('missing-contribution', 'plan review contribution is not a review')], identity)
  }
  if (slotStatus === 'missing') {
    return empty('blocked', [diagnostic('missing-contribution', 'plan review slot has no review')], identity)
  }
  const refs = reviewBlockerRefs(review, new Set(context.accepted.spec.criteria.map((item) => item.id)))
  if (!refs.ok) return empty('blocked', refs.evidence, identity)
  if (
    review.payload.contributions.length > 0 &&
    review.payload.contributions.every((contribution) => {
      const parsed = planReviewSchema.safeParse(contribution.structured)
      return parsed.success && parsed.data.outcome === 'clear'
    })
  ) {
    return empty('eligible', [], identity)
  }
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
  const parsedAmendment = planOutputSchema.safeParse(amendment.payload.structured)
  if (!parsedAmendment.success) {
    return empty('blocked', [diagnostic('malformed', 'amendment is not a plan')], {
      amendmentActionId: amendment.payload.actionId,
      blockers: refs.refs,
    })
  }
  const authored = parsedAmendment.data.resolutions.map((resolution) => resolution.blocker)
  if (
    !sameBlockerSet(amendment.payload.exactInputs.requiredBlockers, refs.refs) ||
    !sameBlockerSet(authored, refs.refs)
  ) {
    return empty(
      'blocked',
      [diagnostic('missing-contribution', 'amendment resolutions do not cover the review refs')],
      {
        amendmentActionId: amendment.payload.actionId,
        blockers: refs.refs,
      },
    )
  }
  const amendmentCoverage = assessPlanCoverage({ spec: context.accepted, plan: parsedAmendment.data })
  if (!amendmentCoverage.ok)
    return empty('blocked', amendmentCoverage.diagnostics, {
      amendmentActionId: amendment.payload.actionId,
      blockers: refs.refs,
    })
  return empty('eligible', [], { ...identity, amendmentActionId: amendment.payload.actionId, blockers: refs.refs })
}

function planResults(history: DecodedHistory): PlanResultReceipt[] {
  return receiptsFor(history, 'plan', 'result').filter(
    (record): record is PlanResultReceipt =>
      record.payload.action === 'plan' && record.payload.phase === 'result' && nativeResultValid(record),
  )
}

function planReviews(history: DecodedHistory): PlanReviewReceipt[] {
  return receiptsFor(history, 'plan-review', 'result').filter(
    (record): record is PlanReviewReceipt =>
      record.payload.action === 'plan-review' && record.payload.phase === 'result' && nativeResultValid(record),
  )
}

function receiptsFor(
  history: DecodedHistory,
  action: 'plan' | 'plan-review',
  phase: 'start' | 'result',
): ReceiptRecord[] {
  return recordsOf(history).filter(
    (record): record is ReceiptRecord =>
      record.kind === 'action-receipt' && record.payload.action === action && record.payload.phase === phase,
  )
}

function planMatchesMandate(record: PlanResultReceipt, mandate: MandateRecord, acceptedDigest: string): boolean {
  const mandateRef: ExternalRecordRef = { scope: mandateScope(mandate), recordId: mandate.recordId, kind: 'mandate' }
  return sameRef(record.payload.mandate, mandateRef) && record.payload.exactInputs.specDigest === acceptedDigest
}

function matchingReview(history: DecodedHistory, mandate: MandateRecord, latest: PlanResultReceipt, digest: string) {
  return uniqueAccounted(
    planReviews(history).filter(
      (record) =>
        !record.payload.contributions.some(
          (contribution) =>
            producerOutputValid('plan-review', contribution.structured) &&
            missingContextOf(contribution.structured) !== null,
        ) &&
        record.payload.exactInputs.planDigest === digest &&
        record.payload.exactInputs.mandateId === mandate.recordId &&
        record.payload.exactInputs.draftActionId === latest.payload.actionId,
    ),
    'plan review',
  )
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

function reviewBlockerRefs(
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

function sameBlockerSet(left: readonly PlanBlockerRef[], right: readonly PlanBlockerRef[]): boolean {
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
