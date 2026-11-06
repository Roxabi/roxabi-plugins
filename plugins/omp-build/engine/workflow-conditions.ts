import { actionCompletion } from './workflow-action-completion.ts'
import type { MandateRecord } from './workflow-control.ts'
import type { WorkflowGraphAction } from './workflow-graph.ts'
import type { ActionCompletion, WorkflowEvidence } from './workflow-plan.ts'
import type { SpecializedDecisions, WorkflowFacts } from './workflow-reconstruction-types.ts'

export function unresolvedWork(
  evidence: WorkflowEvidence,
  facts: WorkflowFacts,
  decisions: SpecializedDecisions,
  mandate: MandateRecord,
): ActionCompletion | null {
  return firstUnresolved(
    ['plan', 'implement', 'assess-spec', 'attribute-ci', 'fix', 'review'],
    evidence,
    facts,
    decisions,
    mandate,
  )
}

/** Non-delivery guards still apply after the assessment-only captured-work inspection. */
export function unresolvedAssessmentWork(
  evidence: WorkflowEvidence,
  facts: WorkflowFacts,
  decisions: SpecializedDecisions,
  mandate: MandateRecord,
): ActionCompletion | null {
  return firstUnresolved(['assess-spec', 'attribute-ci', 'fix', 'review'], evidence, facts, decisions, mandate)
}

function firstUnresolved(
  actions: readonly WorkflowGraphAction[],
  evidence: WorkflowEvidence,
  facts: WorkflowFacts,
  decisions: SpecializedDecisions,
  mandate: MandateRecord,
): ActionCompletion | null {
  for (const action of actions) {
    const completion = actionCompletion(action, evidence, decisions, mandate, facts)
    if (completion.status === 'uncertain' || completion.status === 'blocked') return completion
  }
  return null
}
