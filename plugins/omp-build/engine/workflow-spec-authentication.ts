import { validateActionInputs } from './action-input.ts'
import type { DecodedHistory } from './history-schema.ts'
import { sameRef } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { AcceptedSpecResult } from './workflow-accepted-spec-types.ts'

export { sameAssessInputs } from './workflow-spec-assessment.ts'

import {
  observeAssessmentContextReplay,
  workflowContextNegative,
  workflowContextTerminal,
} from './workflow-context-terminal.ts'
import { bindExternalRef, type ReceiptRecord, recordsOf } from './workflow-control.ts'
import { specChainFailure } from './workflow-spec-assessment.ts'
import { authenticatedAssessResult } from './workflow-spec-authentication-chain.ts'

export type AssessmentReplayContext = { actionId: string; fingerprint: string }

function authenticatedReplayStart(
  record: CanonicalRecord,
  home: DecodedHistory,
  mandateRef: ExternalRecordRef,
  context: AssessmentReplayContext | undefined,
): boolean {
  if (
    context === undefined ||
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
  replayContext?: AssessmentReplayContext,
): AcceptedSpecResult | { ok: true } {
  if (
    replayContext !== undefined &&
    !recordsOf(home).some((record) => authenticatedReplayStart(record, home, mandateRef, replayContext))
  )
    return specChainFailure('incomplete', 'Spec assessment replay start is not authenticated', 'action-uncertain')
  for (const record of recordsOf(home)) {
    const checked = confirmedAssessStart(record, home, histories, mandateRef, replayContext)
    if (!checked.ok) return checked
  }
  return { ok: true }
}

function confirmedAssessStart(
  record: CanonicalRecord,
  home: DecodedHistory,
  histories: readonly DecodedHistory[],
  mandateRef: ExternalRecordRef,
  replayContext?: AssessmentReplayContext,
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
  if (results.length === 0) {
    if (authenticatedReplayStart(record, home, mandateRef, replayContext)) return { ok: true }
    return specChainFailure('incomplete', 'Spec assessment start has no confirmed result', 'action-uncertain')
  }
  if (results.length > 1) return specChainFailure('ambiguous', 'Spec assessment start has competing results')
  const result = results[0]
  if (result !== undefined && result.kind === 'action-receipt' && workflowContextNegative(result))
    return contextAssessment(home, mandateRef, replayContext)
  const authenticated = authenticatedAssessResult(result ?? record, histories, mandateRef)
  return authenticated.ok ? { ok: true } : authenticated
}

function contextAssessment(
  home: DecodedHistory,
  mandateRef: ExternalRecordRef,
  replayContext?: AssessmentReplayContext,
): AcceptedSpecResult | { ok: true } {
  const replayStart = recordsOf(home).find(
    (record): record is ReceiptRecord =>
      record.kind === 'action-receipt' && authenticatedReplayStart(record, home, mandateRef, replayContext),
  )
  const terminal =
    replayStart === undefined
      ? workflowContextTerminal(home, 'assess-spec')
      : observeAssessmentContextReplay(home, replayStart)
  if (terminal === 'clear' || terminal === 'observed') return { ok: true }
  if (terminal === 'ambiguous') return specChainFailure('ambiguous', 'Spec assessment context has competing successors')
  return specChainFailure(
    'incomplete',
    'Spec assessment requires authenticated expanded context',
    terminal === 'missing' ? 'action-context-missing' : 'action-uncertain',
  )
}
