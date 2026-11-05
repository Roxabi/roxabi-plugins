import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, fail } from './record-diagnostics.ts'
import type { Diagnostic } from './record-values.ts'
import type { Result } from './result.ts'
import { workflowOperationProblem } from './workflow-control.ts'
import type { WorkflowCausalContext, WorkflowEvidence } from './workflow-plan.ts'

export function workflowCausalDiagnostics(
  selected: readonly DecodedHistory[],
  causal: WorkflowCausalContext,
): Diagnostic[] {
  const observed = new Map<string, DecodedHistory>()
  for (const history of causal.histories) {
    const key = `${history.source.scope.repository}\0${history.source.scope.target}`
    if (observed.has(key) || !history.source.complete)
      return [diagnostic('fix-history-observation-drift', 'Causal histories must be complete and unique by scope')]
    observed.set(key, history)
  }
  for (const history of selected) {
    const key = `${history.source.scope.repository}\0${history.source.scope.target}`
    if (JSON.stringify(observed.get(key)) !== JSON.stringify(history))
      return [diagnostic('fix-history-observation-drift', 'Selected workflow history differs from causal observation')]
  }
  return []
}

export function composeChantier(input: {
  issue: DecodedHistory
  pullRequest: DecodedHistory | null
  parents: readonly DecodedHistory[]
  causal: WorkflowCausalContext
}): Result<WorkflowEvidence> {
  const histories = [input.issue, ...(input.pullRequest === null ? [] : [input.pullRequest]), ...input.parents]
  for (const history of histories) {
    const problem = workflowOperationProblem(history)
    if (problem !== null) return fail([diagnostic(problem, 'Workflow history cannot be composed')])
  }
  const causalDiagnostics = workflowCausalDiagnostics(histories, input.causal)
  if (causalDiagnostics.length) return fail(causalDiagnostics)
  return {
    ok: true,
    value: { issue: input.issue, pullRequest: input.pullRequest, parents: [...input.parents], causal: input.causal },
  }
}
