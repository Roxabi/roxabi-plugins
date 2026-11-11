import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, incompatibleFormat } from './record-diagnostics.ts'
import { mandatesOf, refused, workflowOperationProblem } from './workflow-control.ts'
import type { MandateSelection } from './workflow-mandate.ts'

export function historyRefusal(history: DecodedHistory): Extract<MandateSelection, { status: 'refused' }> | null {
  const problem = workflowOperationProblem(history)
  if (problem !== null && mandatesOf(history).length === 0 && problem === 'incomplete')
    return refused('incomplete', [diagnostic('incomplete', 'History pagination is incomplete')])
  if (problem === 'ambiguous') return refused('ambiguous', [diagnostic('ambiguous', 'Workflow history conflicts')])
  if (problem === incompatibleFormat) {
    const formatDiagnostic = history.diagnostics.find((entry) => entry.code === problem)
    return refused(problem, [formatDiagnostic ?? diagnostic(problem, 'Mandate uses an incompatible format')])
  }
  if (problem === 'unconfirmed')
    return refused('unconfirmed', [diagnostic('unconfirmed', 'Workflow history has an incomplete operation')])
  if (problem === 'incomplete')
    return refused('incomplete', [diagnostic('incomplete', 'History pagination is incomplete')])
  return null
}
