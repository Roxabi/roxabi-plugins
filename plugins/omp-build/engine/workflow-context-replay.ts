import { validateActionInputs } from './action-input.ts'
import type { DecodedHistory } from './history-schema.ts'
import { bindExternalRef, type ReceiptRecord } from './workflow-control.ts'

/** Authenticate the read-back start; never infer a result or accept a caller-supplied record as authority. */
export function authenticatedContextReplayStart(history: DecodedHistory, start: ReceiptRecord): boolean {
  if (
    start.payload.action !== 'assess-spec' ||
    start.payload.phase !== 'start' ||
    !validateActionInputs(start.payload.inputs).ok
  )
    return false
  const matches = history.operations.filter(
    (operation) =>
      operation.authority !== 'foreign' &&
      operation.record?.kind === 'action-receipt' &&
      operation.record.payload.action === 'assess-spec' &&
      operation.record.payload.actionId === start.payload.actionId,
  )
  if (
    matches.length !== 1 ||
    matches[0]?.authority !== 'accounted' ||
    matches[0].record !== start ||
    history.operations.filter(
      (operation) => operation.authority !== 'foreign' && operation.operationId === start.operationId,
    ).length !== 1
  )
    return false
  const bound = bindExternalRef(
    {
      scope: { repository: start.repository, target: start.target },
      recordId: start.recordId,
      kind: start.kind,
    },
    history,
  )
  return bound.ok && bound.value === start
}

export function hasUnpairedStart(receipts: readonly ReceiptRecord[], replayStart?: ReceiptRecord): boolean {
  return receipts.some(
    (record) =>
      record.payload.phase === 'start' &&
      record !== replayStart &&
      !receipts.some(
        (result) => result.payload.phase === 'result' && result.payload.actionId === record.payload.actionId,
      ),
  )
}
