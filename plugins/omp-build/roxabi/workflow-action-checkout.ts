import { effectiveMandateRole } from '../dist/contracts.js'
import type { WorkflowDecision } from '../engine/workflow-reconstruction-types.ts'
import type { SelectedFeature } from './feature-continuation-selection.ts'
import type { ContinueFeatureInput, ContinueFeatureResult } from './feature-contract.ts'
import { actionRequiresFeatureCheckout, requireMandateCheckout } from './feature-selection.ts'
import type { UwActionRequest } from './uw-action-contract.ts'

export async function checkoutForFeatureAction(
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

export function actionDecisionStop(
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

export function recoveryActionMatches(action: string, request: UwActionRequest): boolean {
  const expected =
    request.purpose === 'integrate' ? 'implement' : request.purpose === 'plan-review' ? 'plan' : request.purpose
  return action === expected
}
