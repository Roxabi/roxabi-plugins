import { createHash } from 'node:crypto'
import type { AcceptedOwnSpec } from '../engine/workflow-accepted-spec-types.ts'
import type {
  NormalizationProposalRequest,
  UwOperationResult,
  UwOperations,
  UwProposalInput,
  UwRead,
} from './uw-contract.ts'

// These capabilities are process-local and never derived from command arguments or model output.
const eligibleRequests = new WeakMap<NormalizationProposalRequest, { requestDigest: string; historyDigest: string }>()
const projections = new WeakMap<UwRead, { accepted: AcceptedOwnSpec; historyDigest: string }>()
const writers = new WeakMap<
  UwOperations,
  (input: UwProposalInput, historyDigest: string) => Promise<UwOperationResult>
>()
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export function markSuccessorNormalization(request: NormalizationProposalRequest, read: UwRead): void {
  const projection = projections.get(read)
  if (projection !== undefined)
    eligibleRequests.set(request, { requestDigest: digest(request), historyDigest: projection.historyDigest })
}
export function bindHistoricalProjection(read: UwRead, accepted: AcceptedOwnSpec, historyDigest: string): void {
  projections.set(read, { accepted, historyDigest })
}
export function historicalProjection(read: UwRead) {
  return projections.get(read)
}
export function bindSuccessorWriter(
  operations: UwOperations,
  write: (input: UwProposalInput, historyDigest: string) => Promise<UwOperationResult>,
): void {
  writers.set(operations, write)
}
export function writeSuccessorNormalization(
  operations: UwOperations,
  request: NormalizationProposalRequest,
  input: UwProposalInput,
): Promise<UwOperationResult> | null {
  const eligibility = eligibleRequests.get(request)
  if (eligibility === undefined) return null
  eligibleRequests.delete(request)
  if (digest(request) !== eligibility.requestDigest) return null
  return writers.get(operations)?.(input, eligibility.historyDigest) ?? null
}
