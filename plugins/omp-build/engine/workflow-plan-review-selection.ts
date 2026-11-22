import { missingContextOf } from './action-context.ts'
import { canonicalValueDigest } from './canonical-value.ts'
import { assessPlanCoverage } from './criterion-admission.ts'
import { nativeResultValid, uniqueAccounted } from './delivery-eligibility.ts'
import type { DecodedHistory } from './history-schema.ts'
import { producerOutputValid } from './producer-schema.ts'
import { diagnostic, sameRef } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { Diagnostic } from './record-values.ts'
import type { SpecEffective } from './spec-effective-schema.ts'
import type { AcceptedOwnSpec } from './workflow-accepted-spec-types.ts'
import { classifyAttempts, interruptionGate, ownAttempts } from './workflow-action-interruption.ts'
import { capturedAssessmentSourcesMatch } from './workflow-assessment-child-sources.ts'
import { authenticateWorkflowReceiptPair, workflowContextTerminal } from './workflow-context-terminal.ts'
import { excludedReceipt, type MandateRecord, mandateScope, type ReceiptRecord, recordsOf } from './workflow-control.ts'
import { planDigest, planOutputSchema } from './workflow-output-schema.ts'
import type { PlanMacro, PlanMacroPhase, WorkflowEvidence } from './workflow-plan.ts'

export type EmptyMacro = (phase: PlanMacroPhase, evidence: Diagnostic[], extra?: Partial<PlanMacro>) => PlanMacro
export type PlanResultReceipt = ReceiptRecord & {
  payload: Extract<ReceiptRecord['payload'], { action: 'plan'; phase: 'result' }>
}
export type PlanReviewReceipt = ReceiptRecord & {
  payload: Extract<ReceiptRecord['payload'], { action: 'plan-review'; phase: 'result' }>
}
export type ReviewContext = {
  latest: PlanResultReceipt
  review: PlanReviewReceipt
  results: PlanResultReceipt[]
  accepted: SpecEffective
}

function reviewContextProblem(
  history: DecodedHistory,
  mandate: MandateRecord,
  empty: EmptyMacro,
  excluded: ReadonlySet<string>,
  contextLeaf?: ReceiptRecord,
): PlanMacro | null {
  const mandateRef: ExternalRecordRef = { scope: mandateScope(mandate), recordId: mandate.recordId, kind: 'mandate' }
  for (const action of ['plan', 'plan-review'] as const) {
    const terminal = workflowContextTerminal(history, action, mandateRef, contextLeaf, excluded)
    if (terminal === 'missing')
      return empty('blocked', [diagnostic('action-context-missing', `${action} requires expanded context`)])
    if (terminal === 'uncertain')
      return empty('uncertain', [diagnostic('action-uncertain', `${action} context result is not authenticated`)])
    if (terminal === 'ambiguous')
      return empty('blocked', [diagnostic('ambiguous', `${action} context result has competing successors`)])
  }
  return null
}

export function prepareReview(
  evidence: WorkflowEvidence,
  mandate: MandateRecord,
  own: AcceptedOwnSpec,
  accepted: SpecEffective,
  empty: EmptyMacro,
  contextLeaf?: ReceiptRecord,
): ReviewContext | { macro: PlanMacro } {
  const history = evidence.issue
  const gate = interruptionGate(
    ownAttempts(
      classifyAttempts({
        histories: [history, ...evidence.causal.histories],
        scan: [history],
        actions: ['plan', 'plan-review'],
      }),
      mandate,
    ),
  )
  if (gate.kind === 'stop')
    return { macro: empty(gate.completion.status === 'uncertain' ? 'uncertain' : 'blocked', gate.completion.evidence) }
  const excluded = gate.excluded
  const problem = reviewContextProblem(history, mandate, empty, excluded, contextLeaf)
  if (problem !== null) return { macro: problem }
  if (unsettledStart(history, 'plan', mandate, planResults(history, excluded), excluded))
    return { macro: empty('uncertain', [diagnostic('action-uncertain', 'plan start has no result')]) }
  if (unsettledStart(history, 'plan-review', mandate, planReviews(history, excluded), excluded))
    return { macro: empty('uncertain', [diagnostic('action-uncertain', 'plan review start has no result')]) }
  const results = planResults(history, excluded).filter(
    (record) =>
      planMatchesMandate(record, mandate, own, accepted, evidence.causal.histories) &&
      !(producerOutputValid('plan', record.payload.structured) && missingContextOf(record.payload.structured) !== null),
  )
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
  const review = matchingReview(history, mandate, latest, planDigest(parsedPlan.data), excluded)
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

function planResults(history: DecodedHistory, excluded: ReadonlySet<string>): PlanResultReceipt[] {
  return receiptsFor(history, 'plan', 'result', excluded).filter(
    (record): record is PlanResultReceipt =>
      record.payload.action === 'plan' && record.payload.phase === 'result' && nativeResultValid(record),
  )
}

function planReviews(history: DecodedHistory, excluded: ReadonlySet<string>): PlanReviewReceipt[] {
  return receiptsFor(history, 'plan-review', 'result', excluded).filter(
    (record): record is PlanReviewReceipt =>
      record.payload.action === 'plan-review' && record.payload.phase === 'result' && nativeResultValid(record),
  )
}

function receiptsFor(
  history: DecodedHistory,
  action: 'plan' | 'plan-review',
  phase: 'start' | 'result',
  excluded: ReadonlySet<string>,
): ReceiptRecord[] {
  return recordsOf(history).filter(
    (record): record is ReceiptRecord =>
      record.kind === 'action-receipt' &&
      record.payload.action === action &&
      record.payload.phase === phase &&
      !excludedReceipt(record, excluded),
  )
}

/**
 * A START of `mandate` without a valid RESULT leaves the plan uncertain. Another mandate's START is settled by a RESULT
 * that authenticates the pair: an interrupted RESULT is not a valid native result, yet it stays with that abandoned or
 * superseded mandate. An orphan START, or one whose RESULT does not authenticate it, still leaves the successor
 * uncertain.
 */
function unsettledStart(
  history: DecodedHistory,
  action: 'plan' | 'plan-review',
  mandate: MandateRecord,
  valid: readonly ReceiptRecord[],
  excluded: ReadonlySet<string>,
): boolean {
  const mandateRef: ExternalRecordRef = { scope: mandateScope(mandate), recordId: mandate.recordId, kind: 'mandate' }
  const results = receiptsFor(history, action, 'result', excluded)
  return receiptsFor(history, action, 'start', excluded).some((start) => {
    if ('scope' in start.payload.mandate && sameRef(start.payload.mandate, mandateRef))
      return !valid.some((result) => result.payload.actionId === start.payload.actionId)
    return !results.some(
      (result) =>
        result.payload.actionId === start.payload.actionId &&
        authenticateWorkflowReceiptPair(history, result, { native: 'unchecked' }).ok,
    )
  })
}

function planMatchesMandate(
  record: PlanResultReceipt,
  mandate: MandateRecord,
  own: AcceptedOwnSpec,
  effective: SpecEffective,
  histories: readonly DecodedHistory[],
): boolean {
  const mandateRef: ExternalRecordRef = { scope: mandateScope(mandate), recordId: mandate.recordId, kind: 'mandate' }
  const manifest = record.payload.inputs.manifest
  return (
    sameRef(record.payload.mandate, mandateRef) &&
    record.payload.exactInputs.specDigest === effective.own.version &&
    manifest.spec.kind === 'accepted' &&
    canonicalValueDigest(manifest.spec.effective) === canonicalValueDigest(effective) &&
    capturedAssessmentSourcesMatch(
      { childOwnSources: [], sourceRefs: own.sourceRefs },
      manifest.acceptedSources,
      histories,
    )
  )
}

function matchingReview(
  history: DecodedHistory,
  mandate: MandateRecord,
  latest: PlanResultReceipt,
  digest: string,
  excluded: ReadonlySet<string>,
) {
  return uniqueAccounted(
    planReviews(history, excluded).filter(
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
