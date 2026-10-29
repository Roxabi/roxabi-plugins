import { isDeepStrictEqual } from 'node:util'
import type { NativeBatchResult } from '../omp/review-runtime/contracts.ts'
import { preMandateMandate } from './delivery-action.ts'
import { matchesContextNegative } from './feature-context-negative.ts'
import type { History } from './feature-engine.ts'
import type { PreparedUwAction } from './uw-action-contract.ts'
import type { NormalizationProposalRequest } from './uw-contract.ts'
import { normalizationSourceDigest } from './uw-normalization-proposal.ts'

export function normalizationNegativeBinding(
  input: {
    request: NormalizationProposalRequest
    prepared: PreparedUwAction
    operationId: string
    startId: string
    result: NativeBatchResult
  },
  history: History,
): string | null {
  if (input.result.canPublishContext?.() !== true) return 'publication-ownership-revoked'
  const child = input.result.children[0]
  if (!child || !matchesContextNegative(child, input.operationId, input.prepared.inputs))
    return 'action-context-binding-mismatch'
  const start = history.operations.find(
    (operation) =>
      operation.status === 'complete' &&
      operation.record?.kind === 'action-receipt' &&
      operation.record.recordId === input.startId &&
      operation.record.payload.phase === 'start' &&
      operation.record.payload.action === 'normalize' &&
      operation.record.payload.actionId === input.operationId,
  )?.record
  if (
    start?.kind !== 'action-receipt' ||
    start.payload.phase !== 'start' ||
    start.payload.action !== 'normalize' ||
    !matchesContextNegative(child, start.payload.actionId, start.payload.inputs) ||
    !isDeepStrictEqual(start.payload.exactInputs, {
      uw: input.request.uw,
      bodySha256: normalizationSourceDigest(input.request),
    }) ||
    !isDeepStrictEqual(start.payload.mandate, preMandateMandate())
  )
    return 'action-start-unconfirmed'
  return null
}
