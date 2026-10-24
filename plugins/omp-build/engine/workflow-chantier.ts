import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, fail } from './record-diagnostics.ts'
import type { Result } from './result.ts'
import { workflowOperationProblem } from './workflow-control.ts'
import type { WorkflowEvidence } from './workflow-plan.ts'

export function composeChantier(input: {
  issue: DecodedHistory
  pullRequest: DecodedHistory | null
  parents: readonly DecodedHistory[]
}): Result<WorkflowEvidence> {
  const histories = [input.issue, ...(input.pullRequest === null ? [] : [input.pullRequest]), ...input.parents]
  for (const history of histories) {
    const problem = workflowOperationProblem(history)
    if (problem !== null) return fail([diagnostic(problem, 'Workflow history cannot be composed')])
  }
  return { ok: true, value: { issue: input.issue, pullRequest: input.pullRequest, parents: [...input.parents] } }
}
