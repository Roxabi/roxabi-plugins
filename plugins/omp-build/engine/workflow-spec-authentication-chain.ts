import { authenticateHistoricalReceiptStart } from './historical-receipt-pair.ts'
import type { DecodedHistory } from './history-schema.ts'
import { equalScope, sameRef } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { AcceptedSpecResult } from './workflow-accepted-spec-types.ts'
import { historyFor } from './workflow-control.ts'
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

function authenticatedRecord(assessed: AssessResultRecord, histories: readonly DecodedHistory[]): Authentication {
  const home = historyFor(assessed, histories)
  if (home === null) return specChainFailure('missing-history', 'Spec assessment history is missing')
  if (assessed.payload.native.completion !== 'completed' || assessed.payload.native.strict !== 'valid')
    return specChainFailure('incomplete', 'Spec assessment is not a confirmed native result', 'unconfirmed')
  const paired = authenticateHistoricalReceiptStart(home, assessed, histories)
  if (!paired.ok) {
    if (paired.stage === 'start')
      return specChainFailure('incomplete', 'Spec assessment start is unresolved', 'unconfirmed')
    if (paired.stage === 'result' || paired.stage === 'manifest')
      return boundFailure(paired.diagnostics.length > 1 ? paired.diagnostics.slice(1) : paired.diagnostics)
    return mismatchedStart()
  }
  const confirmed = paired.value.result
  if (!isAssessResult(confirmed)) return specChainFailure('incomplete', 'Spec assessment is not a result')
  const operands = confirmed.payload.inputs.manifest.operands
  if (operands?.action !== 'assess-spec' || !sameAssessInputs(operands.exactInputs, confirmed.payload.exactInputs))
    return mismatchedStart()
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
  if (!equalScope(assessed, mandateRef.scope)) return mismatchedStart()
  return authenticatedRecord(assessed, histories)
}
