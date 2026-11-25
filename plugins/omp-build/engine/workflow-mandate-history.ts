import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope, incompatibleFormat } from './record-diagnostics.ts'
import { mandatesOf, refused, workflowOperationProblem } from './workflow-control.ts'
import type { MandateSelection } from './workflow-mandate.ts'

type MandateRefusal = Extract<MandateSelection, { status: 'refused' }>

export function historyRefusal(history: DecodedHistory): MandateRefusal | null {
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

/** A record with no decoded control subtype may still be a revocation or successor claim. */
function claimsRevocableAuthority(operation: DecodedHistory['operations'][number]): boolean {
  const record = operation.record
  if (record?.kind === 'mandate' || operation.kind === 'mandate' || operation.claimedKinds.includes('mandate'))
    return true
  if (record?.kind === 'operator-control') {
    const { control } = record.payload
    return control === 'abandon' || control === 'select-successor'
  }
  return operation.kind === 'operator-control' || operation.claimedKinds.includes('operator-control')
}

export function revocationHistoryRefusal(history: DecodedHistory): MandateRefusal | null {
  if (!history.source.complete)
    return refused('incomplete', [diagnostic('incomplete', 'History pagination is incomplete')])
  for (const operation of history.operations) {
    if (operation.authority === 'foreign' || !claimsRevocableAuthority(operation)) continue
    if (operation.status === 'conflict')
      return refused('ambiguous', [diagnostic('ambiguous', 'Mandate authority records conflict')])
    const format = history.diagnostics.find(
      (entry) => entry.code === incompatibleFormat && entry.operationId === operation.operationId,
    )
    if (format !== undefined) return refused(incompatibleFormat, [format])
    if (operation.status !== 'complete' || operation.record === null)
      return refused('unconfirmed', [diagnostic('unconfirmed', 'A mandate authority record is incomplete')])
    if (operation.authority !== 'accounted' || !equalScope(history.source.scope, operation.record))
      return refused('ambiguous', [diagnostic('ambiguous', 'A mandate authority record is not uniquely accounted')])
  }
  return null
}
