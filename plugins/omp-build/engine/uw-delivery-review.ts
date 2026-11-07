import { canonicalValueDigest } from './action-input.ts'
import type { ActionInputs } from './action-input-schema.ts'
import {
  authenticatedCriterionFacts,
  type CriterionDecisionFacts,
  criterionAssessmentForDecision,
} from './criterion-decision.ts'
import { citedOperationIntegrity } from './delivery-observation-authentication.ts'
import type { DecodedHistory } from './history-schema.ts'
import { equalScope, sameRef } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Diagnostic, Scope } from './record-values.ts'
import type { ReviewSummary } from './result.ts'
import { reviewInputsFromInventory, reviewRootFromDecision } from './review-inventory-input.ts'
import { selectedReviewOperations, summarizeReviews } from './review-state.ts'
import type { SpecEffective } from './spec-effective-schema.ts'
import type { UwCompletionObservation } from './uw-completion-types.ts'
import type { UwResult } from './uw-diagnostics.ts'
import { bindExternalRef, historyFor, recordsOf } from './workflow-control.ts'
import { resolveManifestMandate } from './workflow-pr-binding.ts'

export type SelectedDeliveryReview = {
  history: DecodedHistory
  review: Extract<CanonicalRecord, { kind: 'review' }>
  decision: Extract<CanonicalRecord, { kind: 'decision' }>
  inputs: ActionInputs
  facts: CriterionDecisionFacts
  sources: readonly ExternalRecordRef[]
  diagnostics: readonly Diagnostic[]
}

export function deliveryFailure(uw: Scope, code: string, message: string): UwResult<never> {
  return {
    ok: false,
    diagnostics: [{ code, message, location: { kind: 'native', uw, connection: 'state' }, related: [] }],
  }
}

function failureFrom(uw: Scope, diagnostics: readonly Diagnostic[]): UwResult<never> {
  return {
    ok: false,
    diagnostics: diagnostics.map(({ code, message }) => ({
      code,
      message,
      location: { kind: 'native', uw, connection: 'state' },
      related: [],
    })),
  }
}

export function recordRef(record: CanonicalRecord): ExternalRecordRef {
  return {
    scope: { repository: record.repository, target: record.target },
    kind: record.kind,
    recordId: record.recordId,
  }
}

export function authenticatedDeliveryRecord(
  observation: UwCompletionObservation,
  ref: ExternalRecordRef,
): UwResult<CanonicalRecord> {
  const history = historyFor(ref.scope, observation.histories)
  if (history === null || !history.source.complete)
    return deliveryFailure(ref.scope, 'delivery-history-incomplete', `No complete history for ${ref.recordId}`)
  const bound = bindExternalRef(ref, history)
  if (!bound.ok) return failureFrom(ref.scope, bound.diagnostics)
  const integrity = citedOperationIntegrity(history, ref.recordId)
  return integrity === null ? { ok: true, value: bound.value } : failureFrom(ref.scope, [integrity])
}

function authenticatedReviewSources(
  observation: UwCompletionObservation,
  uw: Scope,
  history: DecodedHistory,
  summary: Parameters<typeof selectedReviewOperations>[1],
  inputs: ActionInputs,
): UwResult<readonly ExternalRecordRef[]> {
  const operations = selectedReviewOperations(history, summary)
  if (operations === null || operations.length === 0)
    return deliveryFailure(uw, 'delivery-review-incomplete', 'Selected review operation closure is absent')
  const refs: ExternalRecordRef[] = []
  for (const operation of operations) {
    if (operation.record === null)
      return deliveryFailure(uw, 'delivery-review-incomplete', 'Review source record is absent')
    refs.push(recordRef(operation.record))
  }
  for (const ref of [
    ...inputs.manifest.acceptedSources,
    ...inputs.manifest.deliveryData,
    ...inputs.manifest.expandedContext,
  ]) {
    if (ref.source === 'record') refs.push(ref.record)
  }
  const unique: ExternalRecordRef[] = []
  for (const ref of refs) {
    if (unique.some((item) => sameRef(item, ref))) continue
    const authenticated = authenticatedDeliveryRecord(observation, ref)
    if (!authenticated.ok) return authenticated
    unique.push(ref)
  }
  return { ok: true, value: unique }
}

function selectedReviewRecords(
  history: DecodedHistory,
  reviewId: string,
): {
  review: SelectedDeliveryReview['review']
  decision: SelectedDeliveryReview['decision']
} | null {
  const records = recordsOf(history)
  const review = records.find((record) => record.recordId === reviewId)
  if (review?.kind !== 'review') return null
  const decision = records.find((record) => record.recordId === review.payload.decisionId)
  return decision?.kind === 'decision' && decision.payload.judgment.purpose === 'review' ? { review, decision } : null
}

function selectedInputs(
  uw: Scope,
  selected: Pick<SelectedDeliveryReview, 'decision'>,
  history: DecodedHistory,
  kind: 'pull-request' | 'epic-range',
): UwResult<ActionInputs> {
  const judgment = selected.decision.payload.judgment
  if (judgment.purpose !== 'review')
    return deliveryFailure(uw, 'delivery-review-incomplete', 'Selected review decision is absent')
  const inputs = reviewInputsFromInventory(judgment, history)
  const root = reviewRootFromDecision(selected.decision, history)
  const inventory = root.ok ? root.value.payload : null
  if (
    inputs === null ||
    inventory === null ||
    inventory.stage !== 'initial' ||
    inventory.purpose !== 'review' ||
    inventory.subject.kind !== kind
  )
    return deliveryFailure(
      uw,
      'delivery-review-input-unbound',
      'Final review lacks its authenticated subject and action inputs',
    )
  const code = inputs.manifest.code
  if (inventory.subject.kind === 'epic-range' && inventory.subject.range !== `${code.base}..${code.head}`)
    return deliveryFailure(
      uw,
      'delivery-review-range-mismatch',
      'Final parent review does not identify the integrated range',
    )
  return { ok: true, value: inputs }
}

function inputProblem(
  observation: UwCompletionObservation,
  uw: Scope,
  effective: SpecEffective,
  summary: ReviewSummary,
  inputs: ActionInputs,
): UwResult<never> | null {
  const { subject, spec, code } = inputs.manifest
  if (subject.kind !== 'uw' || !equalScope(subject.uw, uw) || spec.kind !== 'accepted')
    return deliveryFailure(uw, 'delivery-review-input-unbound', 'Final review is not bound to this accepted UW')
  if (canonicalValueDigest(spec.effective) !== canonicalValueDigest(effective))
    return deliveryFailure(
      uw,
      'delivery-review-version-mismatch',
      'Final review does not use the full current accepted version vector',
    )
  if (code.repository !== uw.repository || summary.head !== code.head || summary.input !== inputs.fingerprint)
    return deliveryFailure(
      uw,
      'delivery-review-code-mismatch',
      'Review head or normative fingerprint is not the selected code',
    )
  const mandate = resolveManifestMandate(inputs, observation.histories)
  return mandate.ok ? null : failureFrom(uw, mandate.diagnostics)
}

function criterionFacts(
  observation: UwCompletionObservation,
  uw: Scope,
  selected: Pick<SelectedDeliveryReview, 'history' | 'decision'>,
  inputs: ActionInputs,
  summary: ReviewSummary,
  mode: 'prove' | 'inspect',
  externalHistories: readonly DecodedHistory[],
): UwResult<{ facts: CriterionDecisionFacts; diagnostics: readonly Diagnostic[] }> {
  const judgment = selected.decision.payload.judgment
  if (judgment.purpose !== 'review')
    return deliveryFailure(uw, 'delivery-review-incomplete', 'Selected review decision is absent')
  const facts = authenticatedCriterionFacts(
    judgment,
    selected.history,
    selected.decision.payload.originalContributionId,
    observation.catalogues,
    externalHistories,
    selected.history,
  )
  const code = inputs.manifest.code
  const assessment = criterionAssessmentForDecision(
    judgment,
    inputs,
    facts,
    { repository: code.repository, commit: code.head },
    observation.histories,
  )
  if (mode === 'prove' && (assessment.forceRequestChanges || assessment.diagnostics.length !== 0))
    return assessment.diagnostics.length === 0
      ? deliveryFailure(uw, 'delivery-criterion-not-proven', 'Direct own-criterion evidence is not satisfied')
      : failureFrom(uw, assessment.diagnostics)
  const diagnostics = [...assessment.diagnostics]
  if (summary.spent || !summary.verdict?.startsWith('Approve'))
    diagnostics.push({
      code: 'delivery-review-not-approved',
      message: 'Current review is spent or does not approve delivery',
    })
  return { ok: true, value: { facts, diagnostics } }
}

function readDeliveryReview(
  observation: UwCompletionObservation,
  uw: Scope,
  reviewScope: Scope,
  effective: SpecEffective,
  kind: 'pull-request' | 'epic-range',
  mode: 'prove' | 'inspect',
): UwResult<SelectedDeliveryReview> {
  const history = historyFor(reviewScope, observation.histories)
  if (history === null || !history.source.complete)
    return deliveryFailure(uw, 'delivery-review-incomplete', 'Final review history is missing or incomplete')
  const matching = observation.histories.filter((item) => equalScope(item.source.scope, reviewScope))
  if (matching.length !== 1 || matching[0] !== history)
    return deliveryFailure(uw, 'delivery-review-incomplete', 'Final review history is ambiguous in the observation')
  const externalHistories = observation.histories.filter((item) => item !== history)
  const summary = summarizeReviews(history, observation.catalogues, null, externalHistories)
  if (!summary.ok) return failureFrom(uw, summary.diagnostics)
  if (summary.value.reviewId === null || summary.value.verdict === null)
    return deliveryFailure(uw, 'delivery-review-absent', 'No current authenticated final review')
  if (mode === 'prove' && (summary.value.spent || !summary.value.verdict.startsWith('Approve')))
    return deliveryFailure(
      uw,
      'delivery-review-not-approved',
      'No current unspent authenticated approving final review',
    )
  const selected = selectedReviewRecords(history, summary.value.reviewId)
  if (selected === null) return deliveryFailure(uw, 'delivery-review-incomplete', 'Selected review decision is absent')
  const inputs = selectedInputs(uw, selected, history, kind)
  if (!inputs.ok) return inputs
  const problem = inputProblem(observation, uw, effective, summary.value, inputs.value)
  if (problem !== null) return problem
  const sources = authenticatedReviewSources(observation, uw, history, summary.value, inputs.value)
  if (!sources.ok) return sources
  const criteria = criterionFacts(
    observation,
    uw,
    { history, decision: selected.decision },
    inputs.value,
    summary.value,
    mode,
    externalHistories,
  )
  if (!criteria.ok) return criteria
  return { ok: true, value: { history, ...selected, inputs: inputs.value, ...criteria.value, sources: sources.value } }
}

export function selectDeliveryReview(
  observation: UwCompletionObservation,
  uw: Scope,
  reviewScope: Scope,
  effective: SpecEffective,
  kind: 'pull-request' | 'epic-range',
): UwResult<SelectedDeliveryReview> {
  return readDeliveryReview(observation, uw, reviewScope, effective, kind, 'prove')
}

export function inspectDeliveryReview(
  observation: UwCompletionObservation,
  uw: Scope,
  reviewScope: Scope,
  effective: SpecEffective,
  kind: 'pull-request' | 'epic-range',
): UwResult<SelectedDeliveryReview> {
  return readDeliveryReview(observation, uw, reviewScope, effective, kind, 'inspect')
}
