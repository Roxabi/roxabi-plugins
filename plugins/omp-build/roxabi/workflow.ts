import type { ScopedRecordRef } from '../engine/record-references.ts'
import { currentContextSuccession } from '../engine/workflow-context-succession-current.ts'
import type { WorkflowDecision } from '../engine/workflow-reconstruction-types.ts'
import { prepareRefusal } from './delivery-action.ts'
import { observeCurrentContextSuccession } from './feature-context-handoff-observation.ts'
import { resolveFeatureAuthority } from './feature-continuation-admission.ts'
import { applyFeatureControl } from './feature-continuation-controls.ts'
import { coordinateContinuationEffects } from './feature-continuation-effects.ts'
import { readFeatureObservation } from './feature-continuation-observation.ts'
import { type SelectedFeature, selectFeatureMandate } from './feature-continuation-selection.ts'
import {
  coordinateNonActionDecision,
  deliveryAdmission,
  reenterCompletedParent,
} from './feature-continuation-terminal.ts'
import type { ContinueFeatureInput, ContinueFeatureResult } from './feature-contract.ts'
import { resolveFeatureInterruption } from './feature-interruption.ts'
import type { FeatureObservation } from './feature-observation-contract.ts'
import { plannerSuccessionInspection } from './feature-planner-succession.ts'
import { currentAccountedMandate } from './uw-action-selection.ts'
import { assessmentSuccessionInspection } from './uw-assessment-prestart.ts'
import { createInstalledUwReadPort } from './uw-read-port.ts'
import { actionDecisionStop, checkoutForFeatureAction, recoveryActionMatches } from './workflow-action-checkout.ts'
import { afterMandatePublication, contextSuccessionCoverage } from './workflow-context-coverage.ts'
import {
  assessmentRecoveryBeforeSelection,
  contextRecoveryStop,
  prepareContextRecovery,
} from './workflow-context-recovery.ts'

export { requestFeatureSessionPause } from './workflow-session-pause.ts'

import { acceptOwnMaterialDecision } from './workflow-material-decision.ts'
import { coordinatePlanAndReceiptAction } from './workflow-plan-receipt.ts'
/** Installed /feature continuation. The engine remains the only next-action authority. */
export async function continueFeature(input: ContinueFeatureInput): Promise<ContinueFeatureResult> {
  return continueFeatureAtTarget(input)
}

/** Engine re-entry after a landing or CI watch exit named by `cause`; this call never lands again. */
export async function continueFeatureAfterLanding(
  input: ContinueFeatureInput,
  cause: string,
): Promise<ContinueFeatureResult> {
  return continueFeatureAtTarget(input, undefined, false, false, cause)
}

type Continuation = (
  input: ContinueFeatureInput,
  exactMandateRef?: ScopedRecordRef,
  noImplicitResume?: boolean,
  completedReport?: boolean,
  landingReentry?: string,
) => Promise<ContinueFeatureResult>

/**
 * Every recursion inside one call carries its landing marker, so a call re-entered after landing cannot
 * land again through a material decision, resume, hook, Epic child, report, or completed Parent.
 */
function continueWithin(landingReentry: string | undefined): Continuation {
  return (input, exactMandateRef, noImplicitResume = false, completedReport = false, cause) =>
    continueFeatureAtTarget(input, exactMandateRef, noImplicitResume, completedReport, landingReentry ?? cause)
}

async function continueFeatureAtTarget(
  input: ContinueFeatureInput,
  exactMandateRef?: ScopedRecordRef,
  noImplicitResume = false,
  completedReport = false,
  landingReentry?: string,
): Promise<ContinueFeatureResult> {
  const authority = await resolveFeatureAuthority(input, exactMandateRef)
  if (isResult(authority)) return authority
  if (input.control === 'pause' || input.control === 'abandon')
    return applyFeatureControl(input.control, authority, input.uw)
  if (input.control === 'resolve-interruption') return resolveFeatureInterruption(input, authority)
  if (input.owned?.() === false) return { kind: 'blocked', reason: 'continuation-owner-revoked' }
  const continueAt = continueWithin(landingReentry)
  if (input.control === 'material-decision')
    return acceptOwnMaterialDecision(input, authority, () =>
      continueAt({ ...input, control: 'continue' }, exactMandateRef),
    )
  const mandate = currentAccountedMandate(authority.history)
  const proof = mandate.ok
    ? await plannerSuccessionInspection(mandate.value, authority.causal)
    : { ok: true as const, value: undefined }
  if (!proof.ok) return { kind: 'blocked', reason: prepareRefusal(proof.diagnostics), diagnostics: proof.diagnostics }
  const assessmentReplay = await assessmentRecoveryBeforeSelection(input, authority, proof.value)
  if (assessmentReplay !== null && isResult(assessmentReplay)) return assessmentReplay
  const inspection = assessmentSuccessionInspection(proof.value)
  const reader =
    assessmentReplay === null && inspection === undefined
      ? (input.read ?? input.uw)
      : createInstalledUwReadPort({
          cwd: authority.context.cwd,
          gh: authority.context.gh,
          assessmentReplay: assessmentReplay?.replay,
          assessmentInspection: inspection,
        })
  const selected = await selectFeatureMandate(
    input.control,
    exactMandateRef,
    authority,
    input.uw,
    reader,
    input.parentCoverage,
    input.parentCoverageBasis,
    input.contextHandoff,
    assessmentReplay?.replay,
    inspection,
  )
  if (isResult(selected)) return selected
  return continueSelectedFeature(
    input,
    selected,
    exactMandateRef,
    noImplicitResume,
    completedReport,
    landingReentry,
    continueAt,
  )
}

async function continueSelectedFeature(
  input: ContinueFeatureInput,
  selected: SelectedFeature,
  exactMandateRef: ScopedRecordRef | undefined,
  noImplicitResume: boolean,
  completedReport: boolean,
  landingReentry: string | undefined,
  continueAt: Continuation,
): Promise<ContinueFeatureResult> {
  const consumedHandoff = selected.mandatePublished && input.contextHandoff !== undefined
  if (consumedHandoff && selected.mandateRef === null)
    return { kind: 'blocked', reason: 'context-handoff-successor-required' }
  // Publication consumes the proposed coverage and, when present, the exact context handoff.
  const current = selected.mandatePublished ? afterMandatePublication(input) : input
  const currentRef = consumedHandoff ? (selected.mandateRef ?? undefined) : exactMandateRef
  const observation = await readFeatureObservation(current.control, selected, current)
  const result = isResult(observation)
    ? observation
    : await coordinateDecision(
        current,
        currentRef,
        selected,
        observation,
        noImplicitResume,
        completedReport,
        landingReentry,
        continueAt,
      )
  return consumedHandoff && currentRef !== undefined
    ? contextSuccessionCoverage(result, current, currentRef, continueAt, noImplicitResume, completedReport)
    : result
}

async function coordinateDecision(
  input: ContinueFeatureInput,
  exactMandateRef: ScopedRecordRef | undefined,
  selected: SelectedFeature,
  observation: FeatureObservation,
  noImplicitResume: boolean,
  completedReport: boolean,
  landingReentry: string | undefined,
  continueAt: Continuation,
): Promise<ContinueFeatureResult> {
  const { mandate, acceptedSpec } = selected
  if (mandate !== null && acceptedSpec === null) return { kind: 'blocked', reason: 'mandate-spec-missing' }
  const succession =
    mandate === null
      ? null
      : await observeCurrentContextSuccession({
          authority: selected.authority,
          mandate,
          causal: observation.evidence.causal,
        })
  if (succession !== null && !succession.ok) return { kind: 'blocked', reason: succession.reason }
  const facts =
    succession?.value != null
      ? { ...observation.facts, contextSuccessionObservation: succession.value }
      : observation.facts
  const baseline = selected.authority.context.engine.reconstructWorkflow({
    evidence: observation.evidence,
    facts,
    decisions: observation.decisions,
  })
  const recoveryStop = contextRecoveryStop(input, baseline, facts, mandate)
  if (recoveryStop !== null) return recoveryStop
  if (input.owned?.() === false) return { kind: 'blocked', reason: 'continuation-owner-revoked' }
  const disposition =
    mandate === null
      ? { ok: true as const, value: new Set<string>() }
      : currentContextSuccession(observation.evidence, mandate, facts)
  if (!disposition.ok)
    return { kind: 'blocked', reason: prepareRefusal(disposition.diagnostics), diagnostics: disposition.diagnostics }
  const recovery = await prepareContextRecovery(input, observation, disposition.value)
  if (recovery !== null && isResult(recovery)) return recovery
  const decision =
    recovery === null
      ? baseline
      : selected.authority.context.engine.reconstructWorkflow({
          evidence: observation.evidence,
          facts: {
            ...facts,
            contextRecovery: {
              negative: recovery.negative,
              actionId: recovery.request.actionId,
              inputs: recovery.prepared.inputs,
            },
          },
          decisions: observation.decisions,
        })
  if (input.owned?.() === false) return { kind: 'blocked', reason: 'continuation-owner-revoked' }
  if (decision.status !== 'action')
    return coordinateNonActionDecision(input, exactMandateRef, selected, observation, decision, continueAt)
  return coordinateActionDecision(
    input,
    exactMandateRef,
    selected,
    observation,
    decision,
    noImplicitResume,
    completedReport,
    landingReentry,
    continueAt,
    disposition.value,
    recovery,
    facts,
  )
}

async function coordinateActionDecision(
  input: ContinueFeatureInput,
  exactMandateRef: ScopedRecordRef | undefined,
  selected: SelectedFeature,
  observation: FeatureObservation,
  decision: Extract<WorkflowDecision, { status: 'action' }>,
  noImplicitResume: boolean,
  completedReport: boolean,
  landingReentry: string | undefined,
  continueAt: Continuation,
  disposition: ReadonlySet<string>,
  recovery: Exclude<Awaited<ReturnType<typeof prepareContextRecovery>>, ContinueFeatureResult>,
  facts: FeatureObservation['facts'],
): Promise<ContinueFeatureResult> {
  if (recovery !== null && !recoveryActionMatches(decision.action, recovery.request))
    return { kind: 'blocked', reason: 'context-recovery-action-mismatch' }
  const actionStop = actionDecisionStop(input, decision, noImplicitResume, landingReentry)
  if (actionStop !== null) return actionStop
  const admission = deliveryAdmission(observation, decision.action)
  if (admission !== null) return admission
  if (completedReport && decision.action === 'report') {
    return (
      (await reenterCompletedParent(input, selected, observation, continueAt)) ?? {
        kind: 'blocked',
        reason: 'parent-completion-unavailable',
      }
    )
  }
  const checkout = await checkoutForFeatureAction(selected, decision.action)
  if (checkout !== null) return checkout
  const planned = await coordinatePlanAndReceiptAction(
    input,
    exactMandateRef,
    selected,
    observation,
    decision.action,
    continueAt,
    disposition,
    recovery === null ? undefined : { request: recovery.request, prepared: recovery.prepared },
    facts,
  )
  if (planned !== null) return planned
  return coordinateContinuationEffects(
    input,
    exactMandateRef,
    selected,
    observation,
    decision.action,
    decision.action === 'resume' ? decision.pause : undefined,
    continueAt,
  )
}

function isResult(value: unknown): value is ContinueFeatureResult {
  return value !== null && typeof value === 'object' && 'kind' in value
}
