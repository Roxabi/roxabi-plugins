import type { DecodedHistory } from './history-schema.ts'
import { type MandateRecord, recordsOf } from './workflow-control.ts'
import { implementationCompletion } from './workflow-implementation-completion.ts'
import type { ActionCompletion, WorkflowCausalContext } from './workflow-plan.ts'
import { planMacro } from './workflow-plan-macro.ts'
import { selectWorkflowBinding } from './workflow-pr-binding.ts'
import type { WorkflowBlockReason, WorkflowFacts } from './workflow-reconstruction-types.ts'

export function planConfirmed(
  history: DecodedHistory,
  mandate: MandateRecord | null,
  causal: WorkflowCausalContext,
): boolean {
  return planMacro({ issue: history, pullRequest: null, parents: [], causal }, mandate).phase === 'eligible'
}
export function implementConfirmed(
  history: DecodedHistory,
  mandate: MandateRecord | null,
  causal: WorkflowCausalContext,
): boolean {
  return (
    implementationCompletion({ issue: history, pullRequest: null, parents: [], causal }, mandate).status === 'confirmed'
  )
}
export function prePrStartsAbsent(history: DecodedHistory): boolean {
  return !recordsOf(history).some(
    (record) =>
      record.kind === 'action-receipt' &&
      (record.payload.action === 'plan' ||
        record.payload.action === 'plan-review' ||
        record.payload.action === 'implement'),
  )
}
export function adoptedOrConfirmed(
  history: DecodedHistory,
  mandate: MandateRecord | null,
  causal: WorkflowCausalContext,
): boolean {
  return prePrStartsAbsent(history) || implementConfirmed(history, mandate, causal)
}

export function workflowBound(
  mandate: MandateRecord | null,
  history: DecodedHistory,
  pullRequest: DecodedHistory | null,
  facts: WorkflowFacts,
): boolean {
  if (mandate === null || facts.pullRequest === null || pullRequest === null) return false
  const selected = selectWorkflowBinding({
    pullRequest: facts.pullRequest.scope,
    histories: [history, pullRequest],
    native: { branch: facts.pullRequest.head, base: facts.pullRequest.base },
  })
  return selected.status === 'bound' && selected.mandateRecord.recordId === mandate.recordId
}
export function completionBlockReason(completion: ActionCompletion): WorkflowBlockReason {
  const code = completion.evidence[0]?.code
  if (
    code === 'missing-contribution' ||
    code === 'missing-history' ||
    code === 'unconfirmed' ||
    code === 'action-uncertain'
  )
    return code
  return 'unconfirmed'
}
