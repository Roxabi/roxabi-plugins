import {
  abandoned,
  confirmedAccountedMandate,
  historyFor,
  inspectCapturedWorkForAssessment,
  type MandateRecord,
  mandateScope,
  planMacro,
  recordsOf,
  resolveOwnSpecAuthority,
  selectedMandate,
  successorOf,
} from '../dist/contracts.js'
import type { ActionSpecInput } from '../engine/action-input-schema.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import { sameRef } from '../engine/record-diagnostics.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { Result } from '../engine/result.ts'
import type { ReviewClassCatalogues } from '../engine/review-class-catalogue.ts'
import type { UwCompletionObservation } from '../engine/uw-completion-types.ts'
import type { HistoricalAcceptedSpecContext } from '../engine/workflow-context-succession-inspection.ts'
import type { AcceptedSpecInspection, AssessmentReplayContext } from '../engine/workflow-spec-authentication.ts'

import type { DeliveryDataRef, UwActionRequest } from './uw-action-contract.ts'
import { expandedPlannerMacro, type PlannerExpansion } from './uw-action-negative-expansion.ts'
import { actionFailure } from './uw-action-result.ts'
import { cycle, gatherReceipts, selectedPlanPaths } from './uw-action-selection-receipts.ts'
import { gatherCorrectionRefs } from './uw-action-selection-refs.ts'

export { assertCurrentOutputClosure, currentRootOutputRefs, knownRoleSelector } from './uw-action-closure.ts'

const NEEDS_PLAN: Record<string, true> = {
  implement: true,
  integrate: true,
  review: true,
  'attribute-ci': true,
  correction: true,
}

export function currentAccountedMandate(history: DecodedHistory): Result<MandateRecord> {
  const mandates = recordsOf(history).filter((record): record is MandateRecord => record.kind === 'mandate')
  const confirmed = mandates.filter((mandate) => {
    const ref = { scope: mandateScope(mandate), recordId: mandate.recordId, kind: 'mandate' as const }
    return confirmedAccountedMandate(history, ref) !== null && !abandoned(history, mandate)
  })
  const unique = new Map(confirmed.map((mandate) => [mandate.recordId, mandate]))
  for (const mandate of unique.values()) {
    const next = successorOf(history, mandate)
    if (next !== null && !unique.has(next.recordId)) {
      return actionFailure('record-unreadable', 'Mandate successor is not a confirmed accounted record')
    }
  }
  const open = [...unique.values()].filter((mandate) => successorOf(history, mandate) === null)
  if (open.length === 0) return actionFailure('action-input-missing', 'No current accounted mandate')
  if (open.length > 1) return actionFailure('action-input-cycle', 'Several accounted mandates have no successor')
  const mandate = open[0]
  if (mandate === undefined) return actionFailure('action-input-missing', 'No current accounted mandate')
  const selected = selectedMandate(history)
  if ('status' in selected || selected.recordId !== mandate.recordId)
    return actionFailure('record-unreadable', 'Current mandate has no authenticated unique successor selection')
  return { ok: true, value: mandate }
}

function selectPlanActionId(
  request: UwActionRequest,
  mandate: MandateRecord,
  histories: readonly DecodedHistory[],
  catalogues: ReviewClassCatalogues,
  observation: Extract<UwCompletionObservation, { status: 'complete' }>,
  expansion?: PlannerExpansion,
  excludedStarts?: ReadonlySet<string>,
): Result<string | null> {
  const issue = historyFor(mandateScope(mandate), histories)
  if (issue === null) return actionFailure('record-unreadable', 'Mandate history is absent')
  const pullRequest = request.subject.kind === 'uw' ? request.subject.pullRequest : null
  const evidence = {
    issue,
    pullRequest: pullRequest === null ? null : historyFor(pullRequest, histories),
    parents: [],
    causal: { histories, catalogues, observation },
  }
  const selected =
    expansion === undefined
      ? { ok: true as const, value: planMacro(evidence, mandate, { excludedStarts }) }
      : expandedPlannerMacro(evidence, mandate, expansion, excludedStarts)
  if (!selected.ok) return selected
  const macro = selected.value
  if (macro.phase === 'uncertain' || macro.phase === 'blocked') return { ok: false, diagnostics: macro.evidence }
  const planActionId = macro.amendmentActionId ?? macro.draftActionId
  if (NEEDS_PLAN[request.purpose] && (macro.phase !== 'eligible' || planActionId === null)) {
    return actionFailure('action-input-missing', 'No current eligible plan')
  }
  return { ok: true, value: planActionId }
}

function selectAssessmentData(
  request: UwActionRequest,
  mandate: MandateRecord,
  histories: readonly DecodedHistory[],
  catalogues: ReviewClassCatalogues,
  completionObservation: Extract<UwCompletionObservation, { status: 'complete' }>,
  replay?: AssessmentReplayContext,
  excludedStarts?: ReadonlySet<string>,
  inspection?: AcceptedSpecInspection,
  historical?: HistoricalAcceptedSpecContext,
): Result<{ refs: DeliveryDataRef[]; plannedPaths: readonly string[]; planActionId: string | null }> {
  const issue = historyFor(mandateScope(mandate), histories)
  if (issue === null) return actionFailure('record-unreadable', 'Assessment mandate history is absent')
  const pr = request.subject.kind === 'uw' ? request.subject.pullRequest : null
  const evidence = {
    issue,
    pullRequest: pr === null ? null : historyFor(pr, histories),
    parents: [],
    causal: { histories, catalogues, observation: completionObservation },
  }
  const control = resolveOwnSpecAuthority(
    issue,
    histories.filter((history) => history !== issue),
    evidence.causal,
    new Set(),
    replay,
    inspection,
    historical,
  )
  if (!control.ok) return control
  if (
    !sameRef(
      { scope: mandateScope(control.value.mandate), kind: 'mandate', recordId: control.value.mandate.recordId },
      { scope: mandateScope(mandate), kind: 'mandate', recordId: mandate.recordId },
    )
  )
    return actionFailure('action-input-missing', 'Assessment does not bind the authenticated own mandate')
  const closure = inspectCapturedWorkForAssessment(evidence, replay, excludedStarts, historical)
  return closure.ok ? { ok: true, value: { refs: [], plannedPaths: [], planActionId: null } } : closure
}

export function selectDeliveryData(
  request: UwActionRequest,
  mandate: MandateRecord,
  histories: readonly DecodedHistory[],
  catalogues: ReviewClassCatalogues,
  completionObservation: Extract<UwCompletionObservation, { status: 'complete' }>,
  authenticate: (record: CanonicalRecord) => Result<CanonicalRecord>,
  expansion?: PlannerExpansion,
  spec?: ActionSpecInput,
  excludedStarts?: ReadonlySet<string>,
  assessmentReplay?: AssessmentReplayContext,
  assessmentInspection?: AcceptedSpecInspection,
  historical?: HistoricalAcceptedSpecContext,
): Result<{ refs: DeliveryDataRef[]; plannedPaths: readonly string[]; planActionId: string | null }> {
  if (request.purpose === 'assess-spec')
    return selectAssessmentData(
      request,
      mandate,
      histories,
      catalogues,
      completionObservation,
      assessmentReplay,
      excludedStarts,
      assessmentInspection,
      historical,
    )
  const plan = selectPlanActionId(
    request,
    mandate,
    histories,
    catalogues,
    completionObservation,
    expansion,
    excludedStarts,
  )
  if (!plan.ok) return plan
  const planActionId = plan.value
  const gathered = gatherReceipts(request, mandate, histories, authenticate, planActionId)
  if (!gathered.ok) return gathered
  const corrections = gatherCorrectionRefs(
    request,
    mandate,
    histories,
    catalogues,
    authenticate,
    planActionId,
    spec,
    gathered.value,
  )
  if (!corrections.ok) return corrections
  if (cycle(gathered.value.selected)) return actionFailure('action-input-cycle', 'Delivery references cycle')
  const plannedPaths = selectedPlanPaths(gathered.value)
  if (!plannedPaths.ok) return plannedPaths
  return { ok: true, value: { refs: gathered.value.refs, plannedPaths: plannedPaths.value, planActionId } }
}
