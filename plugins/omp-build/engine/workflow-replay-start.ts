import { validateActionInputs } from './action-input.ts'
import type { DecodedHistory } from './history-schema.ts'
import { equalScope, sameRef } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { CanonicalRecord } from './record-schema.ts'
import { bindExternalRef, type ReceiptRecord } from './workflow-control.ts'
import type { AssessmentReplayContext } from './workflow-spec-authentication.ts'
/** Authenticate one exact persisted workflow START before replaying any of its authority. */
export function authenticateActionReplayStart(
  history: DecodedHistory,
  start: ExternalRecordRef,
  action: string,
  actionId: string,
  fingerprint: string,
): ReceiptRecord | null {
  if (start.kind !== 'action-receipt' || !equalScope(start.scope, history.source.scope)) return null
  const matching = history.operations.filter(
    (operation) =>
      operation.authority !== 'foreign' &&
      operation.record?.kind === 'action-receipt' &&
      operation.record.payload.action === action &&
      operation.record.payload.actionId === actionId,
  )
  const operation = matching[0]
  const record = operation?.record
  if (
    matching.length !== 1 ||
    operation === undefined ||
    operation.authority !== 'accounted' ||
    operation.status !== 'complete' ||
    record?.kind !== 'action-receipt' ||
    record.payload.phase !== 'start' ||
    record.payload.inputs.fingerprint !== fingerprint ||
    !validateActionInputs(record.payload.inputs).ok ||
    !sameRef(start, receiptRef(record)) ||
    operation.recordId !== record.recordId ||
    operation.operationId !== record.operationId ||
    operation.kind !== record.kind ||
    record.repository !== history.source.scope.repository ||
    record.target !== history.source.scope.target ||
    history.operations.filter((item) => item.authority !== 'foreign' && item.operationId === record.operationId)
      .length !== 1
  )
    return null
  const bound = bindExternalRef(start, history)
  return bound.ok && bound.value === record ? record : null
}

export function authenticatedReplayStart(
  record: CanonicalRecord,
  home: DecodedHistory,
  mandateRef: ExternalRecordRef,
  context: AssessmentReplayContext | undefined,
): boolean {
  if (
    context === undefined ||
    context.start === undefined ||
    !equalScope(context.uw, home.source.scope) ||
    !equalScope(context.uw, mandateRef.scope)
  )
    return false
  const start = authenticateActionReplayStart(home, context.start, 'assess-spec', context.actionId, context.fingerprint)
  return (
    start !== null && start === record && 'scope' in start.payload.mandate && sameRef(start.payload.mandate, mandateRef)
  )
}

export function receiptRef(record: CanonicalRecord): ExternalRecordRef {
  return {
    scope: { repository: record.repository, target: record.target },
    recordId: record.recordId,
    kind: record.kind,
  }
}
