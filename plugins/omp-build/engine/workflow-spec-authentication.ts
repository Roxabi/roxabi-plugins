import type { DecodedHistory } from './history-schema.ts'
import { sameRef } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { AcceptedSpecResult } from './workflow-accepted-spec-types.ts'

export { sameAssessInputs } from './workflow-spec-assessment.ts'

import { workflowContextNegative, workflowContextTerminal } from './workflow-context-terminal.ts'
import { recordsOf } from './workflow-control.ts'
import { specChainFailure } from './workflow-spec-assessment.ts'
import { authenticatedAssessResult } from './workflow-spec-authentication-chain.ts'

export function receiptRef(record: CanonicalRecord): ExternalRecordRef {
  return {
    scope: { repository: record.repository, target: record.target },
    recordId: record.recordId,
    kind: record.kind,
  }
}

export function confirmedAssessPairs(
  home: DecodedHistory,
  histories: readonly DecodedHistory[],
  mandateRef: ExternalRecordRef,
): AcceptedSpecResult | { ok: true } {
  for (const record of recordsOf(home)) {
    const checked = confirmedAssessStart(record, home, histories, mandateRef)
    if (!checked.ok) return checked
  }
  return { ok: true }
}

function confirmedAssessStart(
  record: CanonicalRecord,
  home: DecodedHistory,
  histories: readonly DecodedHistory[],
  mandateRef: ExternalRecordRef,
): AcceptedSpecResult | { ok: true } {
  if (record.kind !== 'action-receipt' || record.payload.action !== 'assess-spec' || record.payload.phase !== 'start')
    return { ok: true }
  if (!sameRef(record.payload.mandate, mandateRef)) return { ok: true }
  const startRef = receiptRef(record)
  const results = recordsOf(home).filter(
    (candidate) =>
      candidate.kind === 'action-receipt' &&
      candidate.payload.action === 'assess-spec' &&
      candidate.payload.phase === 'result' &&
      candidate.payload.actionId === record.payload.actionId &&
      sameRef(candidate.payload.start, startRef) &&
      sameRef(candidate.payload.mandate, mandateRef),
  )
  if (results.length === 0)
    return specChainFailure('incomplete', 'Spec assessment start has no confirmed result', 'action-uncertain')
  if (results.length > 1) return specChainFailure('ambiguous', 'Spec assessment start has competing results')
  const result = results[0]
  if (result !== undefined && result.kind === 'action-receipt' && workflowContextNegative(result))
    return contextAssessment(home)
  const authenticated = authenticatedAssessResult(result ?? record, histories, mandateRef)
  return authenticated.ok ? { ok: true } : authenticated
}

function contextAssessment(home: DecodedHistory): AcceptedSpecResult | { ok: true } {
  const terminal = workflowContextTerminal(home, 'assess-spec')
  if (terminal === 'clear') return { ok: true }
  if (terminal === 'ambiguous') return specChainFailure('ambiguous', 'Spec assessment context has competing successors')
  return specChainFailure(
    'incomplete',
    'Spec assessment requires authenticated expanded context',
    terminal === 'missing' ? 'action-context-missing' : 'action-uncertain',
  )
}
