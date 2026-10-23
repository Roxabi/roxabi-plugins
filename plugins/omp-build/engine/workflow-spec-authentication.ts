import type { DecodedHistory } from './history-schema.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { AcceptedSpecResult } from './workflow-accepted-spec.ts'
import { recordsOf } from './workflow-control.ts'
import type { AssessSpecResultPayload } from './workflow-receipt-schema.ts'
import { authenticatedAssessResult } from './workflow-spec-authentication-chain.ts'
import { diagnostic, sameRef } from './workflow-support.ts'

export type AssessResultRecord = {
  repository: string
  target: string
  version: 1
  recordId: string
  runId: string
  operationId: string
  inputs: string[]
  kind: 'action-receipt'
  payload: AssessSpecResultPayload
}
export function isAssessResult(record: CanonicalRecord): record is AssessResultRecord {
  return (
    record.kind === 'action-receipt' && record.payload.action === 'assess-spec' && record.payload.phase === 'result'
  )
}

type SpecChainFailure = Extract<AcceptedSpecResult, { ok: false }>
export function specChainFailure(reason: SpecChainFailure['reason'], message: string, code?: string): SpecChainFailure {
  return { ok: false, reason, evidence: [diagnostic(code ?? reason, message)] }
}

export function receiptRef(record: CanonicalRecord): ExternalRecordRef {
  return {
    scope: { repository: record.repository, target: record.target },
    recordId: record.recordId,
    kind: record.kind,
  }
}

export function sameAssessInputs(
  left: { acceptedDigest: string; currentDigest: string; acceptedBody: string; currentBody: string },
  right: { acceptedDigest: string; currentDigest: string; acceptedBody: string; currentBody: string },
): boolean {
  return (
    left.acceptedDigest === right.acceptedDigest &&
    left.currentDigest === right.currentDigest &&
    left.acceptedBody === right.acceptedBody &&
    left.currentBody === right.currentBody
  )
}

export function confirmedAssessPairs(
  home: DecodedHistory,
  histories: readonly DecodedHistory[],
  mandateRef: ExternalRecordRef,
): AcceptedSpecResult | { ok: true } {
  for (const record of recordsOf(home)) {
    if (record.kind !== 'action-receipt' || record.payload.action !== 'assess-spec' || record.payload.phase !== 'start')
      continue
    if (!sameRef(record.payload.mandate, mandateRef)) continue
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
    const authenticated = authenticatedAssessResult(results[0] ?? record, histories, mandateRef)
    if (!authenticated.ok) return authenticated
  }
  return { ok: true }
}
