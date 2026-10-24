import { diagnostic } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { AcceptedSpecResult } from './workflow-accepted-spec-types.ts'
import type { AssessSpecResultPayload } from './workflow-receipt-schema.ts'

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
