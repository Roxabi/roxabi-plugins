import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope, incompatibleFormat, sameRef } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
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

function claimsRevocableAuthority(operation: DecodedHistory['operations'][number], exact?: ExternalRecordRef): boolean {
  if (
    operation.record?.kind === 'mandate' ||
    operation.kind === 'mandate' ||
    operation.claimedKinds.includes('mandate')
  )
    return exact === undefined || operation.recordId === exact.recordId || operation.record?.recordId === exact.recordId
  const record = operation.record
  // Opaque controls cannot establish a successor or prior revocation. They still
  // block execution where applicable, but cannot prevent an exact revocation.
  if (record?.kind !== 'operator-control') return false
  const control = record.payload
  const subject =
    control.control === 'abandon'
      ? control.mandate
      : control.control === 'select-successor'
        ? control.predecessor
        : null
  return subject !== null && (exact === undefined || sameRef(subject, exact))
}

export function revocationHistoryRefusal(history: DecodedHistory, exact?: ExternalRecordRef): MandateRefusal | null {
  if (!history.source.complete)
    return refused('incomplete', [diagnostic('incomplete', 'History pagination is incomplete')])
  for (const operation of history.operations) {
    if (operation.authority === 'foreign' || !claimsRevocableAuthority(operation, exact)) continue
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
