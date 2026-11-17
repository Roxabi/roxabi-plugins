import { canonicalValueDigest } from '../dist/contracts.js'
import type { DecodedHistory } from '../engine/history-schema.ts'
import { sameRef } from '../engine/record-diagnostics.ts'
import type { Result } from '../engine/result.ts'
import type { ReviewClassCatalogues } from '../engine/review-class-catalogue.ts'
import type { UwCompletionObservation } from '../engine/uw-completion-types.ts'
import type { HistoricalAcceptedSpecContext } from '../engine/workflow-context-succession-inspection.ts'
import type { MandateRecord, ReceiptRecord } from '../engine/workflow-control.ts'
import type { AcceptedSpecInspection, AssessmentReplayContext } from '../engine/workflow-spec-authentication.ts'
import { plannerSuccessionStarts } from './feature-planner-succession.ts'
import { bindSubject } from './uw-action-accepted-state.ts'
import { type EvidenceObservation, resolveEvidenceBasis } from './uw-action-basis.ts'
import { causeActionData } from './uw-action-cause-data.ts'
import type {
  ActionInputManifest,
  ActionReplayIntent,
  ActionSubject,
  CorrectionRootRef,
  CurrentActionFacts,
  RecordInputRef,
  ReviewRootRef,
  UwActionRequest,
} from './uw-action-contract.ts'
import { expansionOrigin } from './uw-action-expansion-origin.ts'
import { type ActionFactSource, authenticate } from './uw-action-observe.ts'
import { actionFailure } from './uw-action-result.ts'
import { authenticateReviewRoot } from './uw-action-review-root.ts'
import { assertCurrentOutputClosure, currentRootOutputRefs, selectDeliveryData } from './uw-action-selection.ts'
import type { IntegrationStageObservation } from './uw-action-stage-closure.ts'
import { validateExpandedWorkflowLive } from './uw-context-negative-live.ts'

function validatePersistedBinding(
  start: ReceiptRecord | null,
  bound: Extract<ReturnType<typeof bindSubject>, { ok: true }>['value'],
): Result<true> {
  if (start === null) return { ok: true, value: true }
  if (
    !bound.mandate.ok ||
    !('scope' in start.payload.mandate) ||
    !sameRef(start.payload.mandate, {
      scope: { repository: bound.mandate.value.repository, target: bound.mandate.value.target },
      kind: 'mandate',
      recordId: bound.mandate.value.recordId,
    })
  )
    return actionFailure('action-input-missing', 'Persisted action START does not bind the current mandate')
  if (canonicalValueDigest(start.payload.inputs.manifest.subject) !== canonicalValueDigest(bound.subject))
    return actionFailure('action-input-missing', 'Persisted action START does not bind the current subject')
  return { ok: true, value: true }
}

export function bindAuthenticatedSubject(
  request: UwActionRequest,
  subject: Extract<ActionSubject, { kind: 'uw' }>,
  histories: readonly DecodedHistory[],
  observed: { branch: string; baseName: string },
  start: ReceiptRecord | null,
): ReturnType<typeof bindSubject> {
  const bound = bindSubject(request, subject, histories, observed)
  if (!bound.ok) return bound
  const authenticated = validatePersistedBinding(start, bound.value)
  return authenticated.ok ? bound : authenticated
}
function integrationOperands(
  request: UwActionRequest,
  mandate: Result<MandateRecord>,
  planActionId: string | null,
  operands: CurrentActionFacts['operands'],
): Result<CurrentActionFacts['operands']> {
  if (request.purpose !== 'integrate') return { ok: true, value: operands }
  if (!mandate.ok || planActionId === null)
    return actionFailure('action-input-missing', 'Integration requires the current mandate and eligible plan')
  const selected = { action: 'integrate' as const, exactInputs: { mandateId: mandate.value.recordId, planActionId } }
  if (request.operands === undefined || canonicalValueDigest(selected) !== canonicalValueDigest(request.operands))
    return actionFailure(
      'review-input-changed',
      'Integration operands differ from the same-cut eligible mandate and plan',
    )
  return { ok: true, value: selected }
}

export async function finishFacts(
  request: UwActionRequest,
  source: ActionFactSource,
  histories: readonly DecodedHistory[],
  catalogues: ReviewClassCatalogues,
  subject: ActionSubject,
  spec: ActionInputManifest['spec'],
  acceptedSources: RecordInputRef[],
  mandate: Result<MandateRecord>,
  operands: CurrentActionFacts['operands'],
  config: ActionInputManifest['configuration'],
  completionObservation: Extract<UwCompletionObservation, { status: 'complete' }>,
  integration: IntegrationStageObservation | undefined,
  reviewedFingerprint?: string,
  observation?: EvidenceObservation,
  reviewedRoot?: ReviewRootRef,
  correctionRoot?: CorrectionRootRef,
  assessmentReplay?: AssessmentReplayContext,
  intent?: ActionReplayIntent,
  assessmentInspection?: AcceptedSpecInspection,
  historical?: HistoricalAcceptedSpecContext,
): Promise<Result<CurrentActionFacts>> {
  const authenticated = authenticateReviewRoot(request, histories, reviewedFingerprint, reviewedRoot, subject)
  if (!authenticated.ok) return authenticated
  const qualified = await qualifyExpansion(
    request,
    source,
    histories,
    catalogues,
    mandate,
    completionObservation,
    reviewedFingerprint,
    intent,
  )
  if (!qualified.ok) return qualified
  const { disposition, expansion } = qualified.value
  const delivery = mandate.ok
    ? selectDeliveryData(
        request,
        mandate.value,
        histories,
        catalogues,
        completionObservation,
        (record) => authenticate(record, histories),
        expansion.value?.planner,
        spec,
        disposition.value,
        assessmentReplay,
        assessmentInspection,
        historical,
      )
    : { ok: true as const, value: { refs: [], plannedPaths: [], planActionId: null } }
  if (!delivery.ok) return delivery
  const selected = integrationOperands(request, mandate, delivery.value.planActionId, operands)
  if (!selected.ok) return selected
  const selectedOperands = selected.value
  const currentOutputs = currentRootOutputRefs(request, histories, reviewedRoot, expansion.value?.root)
  const causes = causeActionData(request, histories, currentOutputs, catalogues)
  if (!causes.ok) return causes
  const deliveryData = [...delivery.value.refs, ...causes.value]
  const basis = await resolveEvidenceBasis(deliveryData, source, observation)
  if (!basis.ok) return basis
  const closed = assertCurrentOutputClosure(
    request,
    { subject, correctionRoot: correctionRoot ?? null },
    histories,
    catalogues,
    [...acceptedSources, ...deliveryData],
    reviewedRoot,
    expansion.value?.root,
    integration,
  )
  if (!closed.ok) return closed
  return {
    ok: true,
    value: {
      spec,
      subject,
      acceptedSources,
      deliveryData,
      plannedPaths: delivery.value.plannedPaths,
      ...(selectedOperands === undefined ? {} : { operands: selectedOperands }),
      currentOutputs,
      configuration: config,
      ...(expansion.value?.previous === undefined ? {} : { expansionPrevious: expansion.value.previous }),
    },
  }
}

async function qualifyExpansion(
  request: UwActionRequest,
  source: ActionFactSource,
  histories: readonly DecodedHistory[],
  catalogues: ReviewClassCatalogues,
  mandate: Result<MandateRecord>,
  completionObservation: Extract<UwCompletionObservation, { status: 'complete' }>,
  reviewedFingerprint?: string,
  intent?: ActionReplayIntent,
) {
  const plannerPrepublication =
    intent?.kind === 'prepublication' && (request.purpose === 'plan' || request.purpose === 'plan-review')
  const disposition = mandate.ok
    ? await plannerSuccessionStarts(
        mandate.value,
        { histories, catalogues, observation: completionObservation },
        source,
      )
    : { ok: true as const, value: new Set<string>() }
  if (!disposition.ok) return disposition
  const expansion = expansionOrigin(
    request,
    histories,
    plannerPrepublication ? undefined : reviewedFingerprint,
    disposition.value,
  )
  if (!expansion.ok) return expansion
  if (expansion.value?.workflow !== undefined) {
    const live = await validateExpandedWorkflowLive(source, request, expansion.value.workflow)
    if (!live.ok) return live
  }
  return { ok: true as const, value: { disposition, expansion } }
}
