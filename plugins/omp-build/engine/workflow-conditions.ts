import { actionCompletion } from './workflow-action-completion.ts'
import type { MandateRecord } from './workflow-control.ts'
import type { ActionCompletion, WorkflowEvidence } from './workflow-plan.ts'
import type { SpecializedDecisions, WorkflowFacts } from './workflow-reconstruction-types.ts'

export function unresolvedWork(
  evidence: WorkflowEvidence,
  facts: WorkflowFacts,
  decisions: SpecializedDecisions,
  mandate: MandateRecord,
): ActionCompletion | null {
  for (const action of ['plan', 'implement', 'assess-spec', 'attribute-ci', 'fix', 'review'] as const) {
    const completion = actionCompletion(action, evidence, decisions, mandate, facts)
    if (completion.status === 'uncertain' || completion.status === 'blocked') return completion
  }
  return null
}
