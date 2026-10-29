import type { DecodedHistory } from '../engine/history-schema.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { Result } from '../engine/result.ts'
import { workflowOperationProblem } from '../engine/workflow-control.ts'
import type { UwActionRequest } from './uw-action-contract.ts'
import { actionFailure } from './uw-action-result.ts'

export function validateExpansionHistory(
  request: UwActionRequest,
  histories: readonly DecodedHistory[],
  records: readonly CanonicalRecord[],
): Result<true> {
  if (histories.some((history) => workflowOperationProblem(history) !== null))
    return actionFailure('record-unreadable', 'Expansion history is incomplete or uncertain')
  if (records.some((record) => record.kind === 'action-receipt' && record.payload.actionId === request.actionId))
    return actionFailure('action-input-cycle', 'Expanded action id is already in use')
  return { ok: true, value: true }
}
