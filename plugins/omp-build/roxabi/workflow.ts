import { effectiveMandateRole } from '../dist/contracts.js'
import type { ScopedRecordRef } from '../engine/record-references.ts'
import type { WorkflowDecision } from '../engine/workflow-reconstruction-types.ts'
import { resolveFeatureAuthority } from './feature-continuation-admission.ts'
import { applyFeatureControl } from './feature-continuation-controls.ts'
import { coordinateContinuationEffects } from './feature-continuation-effects.ts'
import { readFeatureObservation } from './feature-continuation-observation.ts'
import { type SelectedFeature, selectFeatureMandate } from './feature-continuation-selection.ts'
import type { ContinueFeatureInput, ContinueFeatureResult, FeatureSessionPauseInput } from './feature-contract.ts'
import { inhibitCwd } from './feature-control.ts'
import { payload } from './feature-engine.ts'
import type { FeatureObservation } from './feature-observation-contract.ts'
import { actionRequiresFeatureCheckout, moveFromEvidence, requireMandateCheckout } from './feature-selection.ts'
import { acceptMaterialDecision, acceptOwnMaterialDecision } from './workflow-material-decision.ts'
import { coordinatePlanAndReceiptAction } from './workflow-plan-receipt.ts'
/** Installed /feature continuation. The engine remains the only next-action authority. */
export async function continueFeature(input: ContinueFeatureInput): Promise<ContinueFeatureResult> {
  return continueFeatureAtTarget(input)
}
async function continueFeatureAtTarget(
  input: ContinueFeatureInput,
  exactMandateRef?: ScopedRecordRef,
): Promise<ContinueFeatureResult> {
  const authority = await resolveFeatureAuthority(input, exactMandateRef)
  if (isResult(authority)) return authority
  if (input.control === 'pause' || input.control === 'abandon') return applyFeatureControl(input.control, authority)
  if (input.control === 'material-decision')
    return acceptOwnMaterialDecision(input, authority, () =>
      continueFeatureAtTarget({ ...input, control: 'continue' }, exactMandateRef),
    )
  const selected = await selectFeatureMandate(
    input.control,
    exactMandateRef,
    authority,
    input.uw,
    input.read ?? input.uw,
  )
  if (isResult(selected)) return selected
  const observation = await readFeatureObservation(input.control, selected)
  return isResult(observation) ? observation : coordinateDecision(input, exactMandateRef, selected, observation)
}

async function coordinateDecision(
  input: ContinueFeatureInput,
  exactMandateRef: ScopedRecordRef | undefined,
  selected: SelectedFeature,
  observation: FeatureObservation,
): Promise<ContinueFeatureResult> {
  const { mandate, acceptedSpec } = selected
  if (mandate !== null && acceptedSpec === null) return { kind: 'blocked', reason: 'mandate-spec-missing' }
  const decision = selected.authority.context.engine.reconstructWorkflow({
    evidence: observation.evidence,
    facts: observation.facts,
    decisions: observation.decisions,
  })
  if (decision.status !== 'action')
    return coordinateNonActionDecision(input, exactMandateRef, selected, observation, decision)
  if (input.control === 'material-decision') return { kind: 'blocked', reason: 'material-decision-not-pending' }
  const admission = deliveryAdmission(observation, decision.action)
  if (admission !== null) return admission
  const checkout = await checkoutForFeatureAction(selected, decision.action)
  if (checkout !== null) return checkout
  const planned = await coordinatePlanAndReceiptAction(
    input,
    exactMandateRef,
    selected,
    observation,
    decision.action,
    continueFeatureAtTarget,
  )
  if (planned !== null) return planned
  return coordinateContinuationEffects(
    input,
    exactMandateRef,
    selected,
    observation,
    decision.action,
    decision.action === 'resume' ? decision.pause : undefined,
    continueFeatureAtTarget,
  )
}

async function coordinateNonActionDecision(
  input: ContinueFeatureInput,
  exactMandateRef: ScopedRecordRef | undefined,
  selected: SelectedFeature,
  observation: FeatureObservation,
  decision: Exclude<WorkflowDecision, { status: 'action' }>,
): Promise<ContinueFeatureResult> {
  if (decision.status === 'terminal' && decision.reason === 'done') {
    const admission = deliveryAdmission(observation, 'done')
    if (admission !== null) return admission
  }
  return handleNonActionDecision(input, exactMandateRef, selected, observation, decision)
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

function deliveryAdmission(
  observation: FeatureObservation,
  action: Extract<WorkflowDecision, { status: 'action' }>['action'],
): ContinueFeatureResult | null {
  if (action === 'frame' || action === 'assess-spec' || action === 'resume') return null
  const admission = observation.deliveryAdmission
  if (admission === null) return { kind: 'blocked', reason: 'uw-delivery-admission-required' }
  const diagnostics = 'diagnostics' in admission ? admission.diagnostics : admission.admission.deliverable.diagnostics
  return diagnostics.length === 0 ? null : { kind: 'blocked', reason: 'uw-delivery-admission-refused', diagnostics }
}

async function handleNonActionDecision(
  input: ContinueFeatureInput,
  exactMandateRef: ScopedRecordRef | undefined,
  selected: SelectedFeature,
  observation: FeatureObservation,
  decision: Exclude<WorkflowDecision, { status: 'action' }>,
): Promise<ContinueFeatureResult> {
  if (decision.status === 'blocked') return handleBlockedDecision(input, exactMandateRef, selected, decision)
  if (decision.status === 'paused') return { kind: 'paused', confirmed: true, reason: 'paused' }
  if (decision.status === 'abandoned') return { kind: 'abandoned', confirmed: abandonmentConfirmed(observation) }
  return { kind: 'terminal', reason: decision.reason, diagnostics: decision.evidence }
}

async function handleBlockedDecision(
  input: ContinueFeatureInput,
  exactMandateRef: ScopedRecordRef | undefined,
  selected: SelectedFeature,
  decision: Extract<WorkflowDecision, { status: 'blocked' }>,
): Promise<ContinueFeatureResult> {
  const { context, scope } = selected.authority
  if (decision.reason === 'session-cwd')
    return moveFromEvidence(context.cwd, decision.evidence) ?? { kind: 'blocked', reason: 'session-cwd' }
  if (decision.reason !== 'spec-decision-required') {
    return { kind: 'blocked', reason: decision.reason, diagnostics: decision.evidence }
  }
  if (input.control !== 'material-decision') return { kind: 'operator-decision', reason: 'material-spec' }
  return acceptMaterialDecision(input, scope, () =>
    continueFeatureAtTarget({ ...input, control: 'resume' }, exactMandateRef),
  )
}

function abandonmentConfirmed(observation: FeatureObservation): boolean {
  return observation.evidence.issue.operations.some((operation) => {
    const record = operation.record
    return (
      operation.status === 'complete' && record?.kind === 'operator-control' && payload(record).control === 'abandon'
    )
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
