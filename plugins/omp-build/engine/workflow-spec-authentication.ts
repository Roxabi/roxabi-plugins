import type { DecodedHistory } from './history-schema.ts'
import { sameRef } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { AcceptedSpecResult } from './workflow-accepted-spec-types.ts'

export { sameAssessInputs } from './workflow-spec-assessment.ts'

import { workflowContextNegative } from './workflow-context-output.ts'
import { workflowContextTerminal } from './workflow-context-terminal.ts'
import { type ReceiptRecord, recordsOf, scopedStartKey } from './workflow-control.ts'
import { authenticateInterruptedReceiptPair, interruptedResult } from './workflow-interruption-proof.ts'
import { resolutionIndexForStarts } from './workflow-interruption-resolution.ts'
import { specChainFailure } from './workflow-spec-assessment.ts'
import { authenticatedAssessResult } from './workflow-spec-authentication-chain.ts'

type AssessmentFailure = Extract<AcceptedSpecResult, { ok: false }>
type AssessmentPairs = AssessmentFailure | { ok: true; excludedResults: ReadonlySet<string> }

type AssessmentAttempts = {
  abandoned: boolean
  excludedStarts: ReadonlySet<string>
  excludedResults: Set<string>
}

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
  abandoned: boolean,
): AssessmentPairs {
  const starts = recordsOf(home).filter(
    (record): record is ReceiptRecord =>
      record.kind === 'action-receipt' &&
      record.payload.action === 'assess-spec' &&
      record.payload.phase === 'start' &&
      sameRef(record.payload.mandate, mandateRef),
  )
  const { resolved, diagnostics } = resolutionIndexForStarts(
    home,
    histories,
    new Set(starts.map(({ recordId }) => recordId)),
  )
  // Abandonment ends execution obligations, not the evidence behind a successful retry.
  if (!abandoned && diagnostics.length > 0) return { ok: false, reason: 'incomplete', evidence: diagnostics }
  const attempts: AssessmentAttempts = {
    abandoned,
    excludedStarts: new Set(resolved.keys()),
    excludedResults: new Set(),
  }
  for (const { result } of resolved.values())
    if (result !== null) attempts.excludedResults.add(scopedStartKey(receiptRef(result)))
  for (const record of starts) {
    const checked = confirmedAssessStart(record, home, histories, mandateRef, attempts)
    if (!checked.ok) return checked
  }
  return { ok: true, excludedResults: attempts.excludedResults }
}

function confirmedAssessStart(
  record: ReceiptRecord,
  home: DecodedHistory,
  histories: readonly DecodedHistory[],
  mandateRef: ExternalRecordRef,
  attempts: AssessmentAttempts,
): AssessmentFailure | { ok: true } {
  const startRef = receiptRef(record)
  if (attempts.excludedStarts.has(scopedStartKey(startRef))) return { ok: true }
  const results = recordsOf(home).filter(
    (candidate): candidate is ReceiptRecord =>
      candidate.kind === 'action-receipt' &&
      candidate.payload.action === 'assess-spec' &&
      candidate.payload.phase === 'result' &&
      candidate.payload.actionId === record.payload.actionId &&
      sameRef(candidate.payload.start, startRef) &&
      sameRef(candidate.payload.mandate, mandateRef),
  )
  if (results.length > 1) return specChainFailure('ambiguous', 'Spec assessment start has competing results')
  const result = results[0]
  if (result === undefined) {
    // An abandoned START is no longer an execution obligation and establishes no accepted change.
    if (attempts.abandoned) return { ok: true }
    return specChainFailure('incomplete', 'Spec assessment start has no confirmed result', 'action-uncertain')
  }
  return confirmedAssessResult(result, home, histories, mandateRef, attempts)
}

function confirmedAssessResult(
  result: ReceiptRecord,
  home: DecodedHistory,
  histories: readonly DecodedHistory[],
  mandateRef: ExternalRecordRef,
  attempts: AssessmentAttempts,
): AssessmentFailure | { ok: true } {
  if (attempts.abandoned && interruptedResult(result)) {
    const pair = authenticateInterruptedReceiptPair(home, result)
    if (!pair.ok) return { ok: false, reason: 'incomplete', evidence: pair.diagnostics }
    attempts.excludedResults.add(scopedStartKey(receiptRef(result)))
    return { ok: true }
  }
  if (workflowContextNegative(result)) return contextAssessment(home, mandateRef, attempts.excludedStarts)
  const authenticated = authenticatedAssessResult(result, histories, mandateRef)
  return authenticated.ok ? { ok: true } : authenticated
}

function contextAssessment(
  home: DecodedHistory,
  mandateRef: ExternalRecordRef,
  excluded: ReadonlySet<string>,
): AssessmentFailure | { ok: true } {
  const terminal = workflowContextTerminal(home, 'assess-spec', mandateRef, excluded)
  if (terminal === 'clear') return { ok: true }
  if (terminal === 'ambiguous') return specChainFailure('ambiguous', 'Spec assessment context has competing successors')
  return specChainFailure(
    'incomplete',
    'Spec assessment requires authenticated expanded context',
    terminal === 'missing' ? 'action-context-missing' : 'action-uncertain',
  )
}
