import { effectiveMandateRole } from '../dist/contracts.js'
import type { ScopedRecordRef } from '../engine/record-references.ts'
import type { WorkflowDecision } from '../engine/workflow-reconstruction-types.ts'
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
import type { ContinueFeatureInput, ContinueFeatureResult, FeatureSessionPauseInput } from './feature-contract.ts'
import { inhibitCwd } from './feature-control.ts'
import { resolveFeatureInterruption } from './feature-interruption.ts'
import type { FeatureObservation } from './feature-observation-contract.ts'
import { actionRequiresFeatureCheckout, requireMandateCheckout } from './feature-selection.ts'
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
  const selected = await selectFeatureMandate(
    input.control,
    exactMandateRef,
    authority,
    input.uw,
    input.read ?? input.uw,
    input.parentCoverage,
    input.parentCoverageBasis,
  )
  if (isResult(selected)) return selected
  // A newly published Mandate consumed the intent; its accepted coverage governs the rest of this call.
  const current = selected.mandatePublished ? withoutCoverageIntent(input) : input
  const observation = await readFeatureObservation(current.control, selected, current)
  return isResult(observation)
    ? observation
    : coordinateDecision(
        current,
        exactMandateRef,
        selected,
        observation,
        noImplicitResume,
        completedReport,
        landingReentry,
        continueAt,
      )
}

function withoutCoverageIntent(input: ContinueFeatureInput): ContinueFeatureInput {
  const { parentCoverage: _coverage, parentCoverageBasis: _basis, ...rest } = input
  return rest
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
  const decision = selected.authority.context.engine.reconstructWorkflow({
    evidence: observation.evidence,
    facts: observation.facts,
    decisions: observation.decisions,
  })
  if (input.owned?.() === false) return { kind: 'blocked', reason: 'continuation-owner-revoked' }
  if (decision.status !== 'action')
    return coordinateNonActionDecision(input, exactMandateRef, selected, observation, decision, continueAt)
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

function actionDecisionStop(
  input: ContinueFeatureInput,
  decision: Extract<WorkflowDecision, { status: 'action' }>,
  noImplicitResume: boolean,
  landingReentry: string | undefined,
): ContinueFeatureResult | null {
  // A landing that sent the feature back to the engine is not repeated in the same call.
  if (landingReentry !== undefined && decision.action === 'land')
    return { kind: 'blocked', reason: `land-repeat-refused:${landingReentry}`, next: 'feature-reentry' }
  if (input.control === 'material-decision') return { kind: 'blocked', reason: 'material-decision-not-pending' }
  if (noImplicitResume && decision.action === 'resume') return { kind: 'paused', confirmed: true, reason: 'paused' }
  return null
}

async function checkoutForFeatureAction(
  selected: SelectedFeature,
  action: Extract<WorkflowDecision, { status: 'action' }>['action'],
): Promise<ContinueFeatureResult | null> {
  const { authority, mandate, acceptedSpec } = selected
  if (
    mandate === null ||
    acceptedSpec === null ||
    effectiveMandateRole(mandate.payload.role, acceptedSpec) !== 'feature' ||
    !actionRequiresFeatureCheckout(action)
  )
    return null
  return requireMandateCheckout({
    cwd: authority.context.cwd,
    git: authority.context.git,
    scope: authority.scope,
    mandate,
  })
}

function isResult(value: unknown): value is ContinueFeatureResult {
  return value !== null && typeof value === 'object' && 'kind' in value
}

export async function requestFeatureSessionPause(input: FeatureSessionPauseInput): Promise<ContinueFeatureResult> {
  inhibitCwd(input.cwd)
  const result: ContinueFeatureResult =
    input.reference === undefined
      ? { kind: 'paused', confirmed: false, reason: input.reason }
      : await continueFeatureAtTarget({
          cwd: input.cwd,
          reference: input.reference,
          control: 'pause',
          principal: false,
          gh: input.gh,
        })
  await input.interrupt('session')
  return result
}
