import type { DecodedHistory } from './history-schema.ts'
import { sameRef } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { AcceptedSpecResult } from './workflow-accepted-spec-types.ts'
import { bindExternalRef, historyFor } from './workflow-control.ts'
import {
  type AssessResultRecord,
  isAssessResult,
  sameAssessInputs,
  specChainFailure,
} from './workflow-spec-assessment.ts'

type SpecChainFailure = Extract<AcceptedSpecResult, { ok: false }>
type Authentication = SpecChainFailure | { ok: true; record: AssessResultRecord }

function boundFailure(diagnostics: SpecChainFailure['evidence']): SpecChainFailure {
  const code = diagnostics[0]?.code
  const reason =
    code === 'conflict' || code === 'ambiguous'
      ? 'ambiguous'
      : code === 'missing-history'
        ? 'missing-history'
        : 'incomplete'
  return { ok: false, reason, evidence: diagnostics }
}

function mismatchedStart(): SpecChainFailure {
  return specChainFailure('incomplete', 'Spec assessment start does not match its result', 'unconfirmed')
}

function authenticateStart(
  confirmed: AssessResultRecord,
  histories: readonly DecodedHistory[],
  mandateRef: ExternalRecordRef,
): SpecChainFailure | { ok: true } {
  const startHistory = historyFor(confirmed.payload.start.scope, histories)
  if (startHistory === null) return specChainFailure('incomplete', 'Spec assessment start is unresolved', 'unconfirmed')
  const start = bindExternalRef(confirmed.payload.start, startHistory)
  if (!start.ok) return specChainFailure('incomplete', 'Spec assessment start is unresolved', 'unconfirmed')
  if (start.value.kind !== 'action-receipt') return mismatchedStart()
  const startPayload = start.value.payload
  if (startPayload.action !== 'assess-spec' || startPayload.phase !== 'start') return mismatchedStart()
  if (startPayload.actionId !== confirmed.payload.actionId) return mismatchedStart()
  if (!sameRef(startPayload.mandate, mandateRef)) return mismatchedStart()
  if (!sameAssessInputs(startPayload.exactInputs, confirmed.payload.exactInputs)) return mismatchedStart()
  return { ok: true }
}

function authenticatedRecord(
  assessed: AssessResultRecord,
  histories: readonly DecodedHistory[],
  mandateRef: ExternalRecordRef,
): Authentication {
  const home = historyFor({ repository: assessed.repository, target: assessed.target }, histories)
  if (home === null) return specChainFailure('missing-history', 'Spec assessment history is missing')
  const bound = bindExternalRef(
    {
      scope: { repository: assessed.repository, target: assessed.target },
      recordId: assessed.recordId,
      kind: assessed.kind,
    },
    home,
  )
  if (!bound.ok) return boundFailure(bound.diagnostics)
  if (!isAssessResult(bound.value)) return specChainFailure('incomplete', 'Spec assessment is not a result')
  const confirmed = bound.value
  if (confirmed.payload.native.completion !== 'completed' || confirmed.payload.native.strict !== 'valid')
    return specChainFailure('incomplete', 'Spec assessment is not a confirmed native result', 'unconfirmed')
  const start = authenticateStart(confirmed, histories, mandateRef)
  if (!start.ok) return start
  return { ok: true, record: confirmed }
}

export function authenticatedAssessResult(
  record: CanonicalRecord,
  histories: readonly DecodedHistory[],
  mandateRef: ExternalRecordRef,
): Authentication {
  if (!isAssessResult(record)) return specChainFailure('incomplete', 'Spec assessment is not a result')
  const assessed = record
  if (!sameRef(assessed.payload.mandate, mandateRef))
    return specChainFailure('ambiguous', 'Spec assessment names a different mandate')
  return authenticatedRecord(assessed, histories, mandateRef)
}
