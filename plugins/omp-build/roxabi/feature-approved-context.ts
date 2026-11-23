import type { ActionReceiptPayload, WorkflowReceiptAction } from '../engine/workflow-receipt-schema.ts'
import type { History, HistoryRecord } from './feature-engine.ts'

export type ActionStartReceipt<A extends WorkflowReceiptAction = WorkflowReceiptAction> = Omit<
  Extract<HistoryRecord, { kind: 'action-receipt' }>,
  'payload'
> & { payload: Extract<ActionReceiptPayload, { phase: 'start' }> & { action: A } }
function isAssessmentStart(record: HistoryRecord | null): record is ActionStartReceipt<'assess-spec'> {
  return (
    record?.kind === 'action-receipt' && record.payload.phase === 'start' && record.payload.action === 'assess-spec'
  )
}

export function startedActionReceipt(
  history: History,
  start: { recordId: string },
  operationId: string,
): ActionStartReceipt<'assess-spec'> | null {
  for (const operation of history.operations) {
    const record = operation.record
    if (
      operation.status === 'complete' &&
      isAssessmentStart(record) &&
      record.recordId === start.recordId &&
      record.payload.actionId === operationId
    ) {
      return record
    }
  }
  return null
}
