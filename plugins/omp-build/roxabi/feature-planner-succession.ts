import { prepareContextSuccessionInspection } from '../dist/contracts.js'
import type { Result } from '../engine/result.ts'
import { currentContextSuccession } from '../engine/workflow-context-succession-current.ts'
import type { ContextSuccessionInspection } from '../engine/workflow-context-succession-inspection.ts'
import { controlsOf, type MandateRecord, mandateScope } from '../engine/workflow-control.ts'
import type { WorkflowCausalContext } from '../engine/workflow-plan.ts'
import { observeCurrentContextSuccession } from './feature-context-handoff-observation.ts'
import { resolveFeatureAuthority } from './feature-continuation-admission.ts'
import type { ActionFactSource } from './uw-action-observe.ts'
import { actionFailure } from './uw-action-result.ts'

/** Authenticate the historical disposition for read-only accepted Spec inspection. */
export async function plannerSuccessionInspection(
  mandate: MandateRecord,
  causal: WorkflowCausalContext,
): Promise<Result<ContextSuccessionInspection | undefined>> {
  const scope = mandateScope(mandate)
  const issue = causal.histories.find(
    (history) => history.source.scope.repository === scope.repository && history.source.scope.target === scope.target,
  )
  if (issue === undefined) return actionFailure('record-unreadable', 'Mandate history is absent')
  return prepareContextSuccessionInspection(
    { issue, pullRequest: null, parents: causal.histories.filter((history) => history !== issue), causal },
    mandate,
  )
}

export async function plannerSuccessionStarts(
  mandate: MandateRecord,
  causal: WorkflowCausalContext,
  source: ActionFactSource,
): Promise<Result<ReadonlySet<string>>> {
  const scope = mandateScope(mandate)
  const issue = causal.histories.find(
    (history) => history.source.scope.repository === scope.repository && history.source.scope.target === scope.target,
  )
  if (issue === undefined) return actionFailure('record-unreadable', 'Mandate history is absent')
  const hasDisposition = controlsOf(issue).some(
    (control) =>
      control.payload.control === 'select-successor' &&
      control.payload.contextDisposition !== undefined &&
      control.payload.successor.recordId === mandate.recordId &&
      control.payload.successor.scope.repository === scope.repository &&
      control.payload.successor.scope.target === scope.target,
  )
  if (!hasDisposition) return { ok: true, value: new Set() }
  const authority = await resolveFeatureAuthority(
    {
      cwd: source.cwd,
      gh: source.gh,
      git: source.git,
      reference: scope.target,
      control: 'continue',
      principal: false,
    },
    { scope, kind: 'mandate', recordId: mandate.recordId },
  )
  if ('kind' in authority) return actionFailure('action-input-missing', 'Context succession authority is unavailable')
  const observation = await observeCurrentContextSuccession({ authority, mandate, causal })
  if (!observation.ok || observation.value === null)
    return actionFailure('action-input-missing', 'Context succession baseline is unavailable')
  return currentContextSuccession(
    { issue, pullRequest: null, parents: causal.histories.filter((history) => history !== issue), causal },
    mandate,
    { contextSuccessionObservation: observation.value },
  )
}
