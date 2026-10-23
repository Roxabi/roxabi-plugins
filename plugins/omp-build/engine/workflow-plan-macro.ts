import type { DecodedHistory } from './history-schema.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { Diagnostic } from './record-values.ts'
import { resolveAcceptedSpec } from './workflow-accepted-spec.ts'
import { type MandateRecord, mandateScope, type ReceiptRecord, recordsOf } from './workflow-control.ts'
import {
  type PlanBlockerRef,
  type PlanOutput,
  planDigest,
  planOutputSchema,
  planReviewSchema,
} from './workflow-output-schema.ts'
import type { PlanMacro, PlanMacroPhase, WorkflowEvidence } from './workflow-plan.ts'
import { PLAN_REVIEW_SPECIALISTS } from './workflow-receipt-schema.ts'
import { diagnostic, sameRef } from './workflow-support.ts'

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
}

export function planMacro(evidence: WorkflowEvidence, mandate: MandateRecord | null): PlanMacro {
  const empty = emptyMacro(mandate, null)
  if (mandate === null) return empty('blocked', [diagnostic('mandate-absent', 'plan macro has no mandate')])
  const accepted = resolveAcceptedSpec(mandate, [
    evidence.issue,
    ...(evidence.pullRequest === null ? [] : [evidence.pullRequest]),
    ...evidence.parents,
  ])
  if (!accepted.ok) return empty('blocked', accepted.evidence)
  const acceptedEmpty = emptyMacro(mandate, accepted.spec.digest)
  const reviewContext = prepareReview(evidence.issue, mandate, accepted.spec.digest, acceptedEmpty)
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
  acceptedDigest: string,
  empty: EmptyMacro,
): ReviewContext | { macro: PlanMacro } {
  const starts = receiptsFor(history, 'plan', 'start')
  const results = planResults(history).filter((record) => planMatchesMandate(record, mandate, acceptedDigest))
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
  const latest = results.filter((record) => record.payload.exactInputs.amendsReviewActionId === null).at(-1)
  if (latest === undefined) {
    return { macro: empty('needs-draft', [diagnostic('needs-draft', 'no plan result is bound to the mandate spec')]) }
  }
  const parsedPlan = planOutputSchema.safeParse(latest.payload.structured)
  if (!parsedSuccess(parsedPlan))
    return { macro: empty('blocked', [diagnostic('malformed', 'plan result is not a plan')]) }
  const review = matchingReview(history, mandate, latest, planDigest(parsedPlan.data))
  if (review === undefined) {
    return {
      macro: empty('needs-review', [diagnostic('needs-review', 'plan has no matching review')], {
        draftActionId: latest.payload.actionId,
      }),
    }
  }
  return { latest, review, results }
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
  const refs = reviewBlockerRefs(review)
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
  const amendment = results
    .filter((record) => record.payload.exactInputs.amendsReviewActionId === review.payload.actionId)
    .at(-1)
  if (amendment === undefined) {
    return empty('needs-amendment', [diagnostic('needs-amendment', 'blocking review has no amendment')], {
      ...identity,
      blockers: refs.refs,
    })
  }
  const parsedAmendment = planOutputSchema.safeParse(amendment.payload.structured)
  if (!parsedSuccess(parsedAmendment)) {
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
  return empty('eligible', [], { ...identity, amendmentActionId: amendment.payload.actionId, blockers: refs.refs })
}

function planResults(history: DecodedHistory): PlanResultReceipt[] {
  return receiptsFor(history, 'plan', 'result').filter(
    (record): record is PlanResultReceipt => record.payload.action === 'plan' && record.payload.phase === 'result',
  )
}

function planReviews(history: DecodedHistory): PlanReviewReceipt[] {
  return receiptsFor(history, 'plan-review', 'result').filter(
    (record): record is PlanReviewReceipt =>
      record.payload.action === 'plan-review' && record.payload.phase === 'result',
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

function matchingReview(
  history: DecodedHistory,
  mandate: MandateRecord,
  latest: PlanResultReceipt,
  digest: string,
): PlanReviewReceipt | undefined {
  return planReviews(history)
    .filter(
      (record) =>
        record.payload.exactInputs.planDigest === digest &&
        record.payload.exactInputs.mandateId === mandate.recordId &&
        record.payload.exactInputs.draftActionId === latest.payload.actionId,
    )
    .at(-1)
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

function parsedSuccess(
  parsed: { success: true; data: PlanOutput } | { success: false },
): parsed is { success: true; data: PlanOutput } {
  return parsed.success
}
