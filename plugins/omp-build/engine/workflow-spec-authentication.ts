import { validateActionInputs } from './action-input.ts'
import type { DecodedHistory } from './history-schema.ts'
import { equalScope, sameRef } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Scope } from './record-values.ts'
import type { AcceptedSpecResult } from './workflow-accepted-spec-types.ts'

export { sameAssessInputs } from './workflow-spec-assessment.ts'

import { workflowContextNegative } from './workflow-context-output.ts'
import { observeAssessmentContextReplay, workflowContextTerminal } from './workflow-context-terminal.ts'
import { bindExternalRef, type ReceiptRecord, recordsOf, scopedStartKey } from './workflow-control.ts'
import { authenticateInterruptedReceiptPair, interruptedResult } from './workflow-interruption-proof.ts'
import { resolutionIndexForStarts } from './workflow-interruption-resolution.ts'
import { specChainFailure } from './workflow-spec-assessment.ts'
import { authenticatedAssessResult } from './workflow-spec-authentication-chain.ts'

export type AssessmentReplayContext = { uw: Scope; actionId: string; fingerprint: string }

type AssessmentFailure = Extract<AcceptedSpecResult, { ok: false }>
type AssessmentPairs = AssessmentFailure | { ok: true; excludedResults: ReadonlySet<string> }

type AssessmentAttempts = {
  abandoned: boolean
  excludedStarts: ReadonlySet<string>
  excludedResults: Set<string>
}

function authenticatedReplayStart(
  record: CanonicalRecord,
  home: DecodedHistory,
  mandateRef: ExternalRecordRef,
  context: AssessmentReplayContext | undefined,
): boolean {
  if (
    context === undefined ||
    !equalScope(context.uw, home.source.scope) ||
    !equalScope(context.uw, mandateRef.scope) ||
    record.kind !== 'action-receipt' ||
    record.payload.action !== 'assess-spec' ||
    record.payload.phase !== 'start' ||
    record.payload.actionId !== context.actionId ||
    !sameRef(record.payload.mandate, mandateRef) ||
    record.payload.inputs.fingerprint !== context.fingerprint ||
    !validateActionInputs(record.payload.inputs).ok
  )
    return false
  const matchingActions = home.operations.filter(
    (operation) =>
      operation.authority !== 'foreign' &&
      operation.record?.kind === 'action-receipt' &&
      operation.record.payload.action === 'assess-spec' &&
      operation.record.payload.actionId === context.actionId,
  )
  if (matchingActions.length !== 1) return false
  if (
    home.operations.filter(
      (operation) => operation.authority !== 'foreign' && operation.operationId === record.operationId,
    ).length !== 1
  )
    return false
  const operation = matchingActions[0]
  if (
    operation === undefined ||
    operation.authority !== 'accounted' ||
    operation.status !== 'complete' ||
    operation.recordId !== record.recordId ||
    operation.operationId !== record.operationId ||
    operation.kind !== record.kind ||
    operation.record !== record ||
    record.repository !== home.source.scope.repository ||
    record.target !== home.source.scope.target
  )
    return false
  const bound = bindExternalRef(receiptRef(record), home)
  return bound.ok && bound.value === record
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
  replayContext?: AssessmentReplayContext,
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
  if (
    replayContext !== undefined &&
    !starts.some((record) => authenticatedReplayStart(record, home, mandateRef, replayContext))
  )
    return specChainFailure('incomplete', 'Spec assessment replay start is not authenticated', 'action-uncertain')
  for (const record of starts) {
    const checked = confirmedAssessStart(record, home, histories, mandateRef, attempts, replayContext)
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
  replayContext?: AssessmentReplayContext,
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
    if (attempts.abandoned || authenticatedReplayStart(record, home, mandateRef, replayContext)) return { ok: true }
    return specChainFailure('incomplete', 'Spec assessment start has no confirmed result', 'action-uncertain')
  }
  return confirmedAssessResult(result, home, histories, mandateRef, attempts, replayContext)
}

function confirmedAssessResult(
  result: ReceiptRecord,
  home: DecodedHistory,
  histories: readonly DecodedHistory[],
  mandateRef: ExternalRecordRef,
  attempts: AssessmentAttempts,
  replayContext?: AssessmentReplayContext,
): AssessmentFailure | { ok: true } {
  if (attempts.abandoned && interruptedResult(result)) {
    const pair = authenticateInterruptedReceiptPair(home, result)
    if (!pair.ok) return { ok: false, reason: 'incomplete', evidence: pair.diagnostics }
    attempts.excludedResults.add(scopedStartKey(receiptRef(result)))
    return { ok: true }
  }
  if (workflowContextNegative(result)) {
    return contextAssessment(home, mandateRef, attempts.excludedStarts, replayContext)
  }
  const authenticated = authenticatedAssessResult(result, histories, mandateRef)
  return authenticated.ok ? { ok: true } : authenticated
}

function contextAssessment(
  home: DecodedHistory,
  mandateRef: ExternalRecordRef,
  excluded: ReadonlySet<string>,
  replayContext?: AssessmentReplayContext,
): AssessmentFailure | { ok: true } {
  const replayStart = recordsOf(home).find(
    (record): record is ReceiptRecord =>
      record.kind === 'action-receipt' && authenticatedReplayStart(record, home, mandateRef, replayContext),
  )
  const terminal =
    replayStart === undefined
      ? workflowContextTerminal(home, 'assess-spec', mandateRef, undefined, excluded)
      : observeAssessmentContextReplay(home, replayStart, mandateRef, excluded)
  if (terminal === 'clear' || terminal === 'observed') return { ok: true }
  if (terminal === 'ambiguous') return specChainFailure('ambiguous', 'Spec assessment context has competing successors')
  return specChainFailure(
    'incomplete',
    'Spec assessment requires authenticated expanded context',
    terminal === 'missing' ? 'action-context-missing' : 'action-uncertain',
  )
}
