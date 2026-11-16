import { randomUUID } from 'node:crypto'
import type { Json, OwnSpecRef, RecordDraft } from '../dist/contracts.js'
import { buildRecord } from '../dist/contracts.js'
import type { ReservedRecordIdentity } from '../engine/fix-recovery-identities.ts'
import type {
  FixActionResult,
  FixIdentity,
  FixRecord,
  FixScope,
  PublishBinding,
  RecordPublisher,
} from './fix-contract.ts'
import { capturedSubmission, failure, isRecordId } from './fix-contract.ts'

export function record(
  identity: FixIdentity,
  scope: FixScope,
  kind: FixRecord['kind'],
  payload: Json,
  contextInputs: readonly string[] = [],
  recordId = identity.nextRecordId(kind),
): FixRecord {
  const draft = {
    version: 1,
    recordId,
    runId: identity.runId,
    operationId: `${identity.operationId}-${recordId}`,
    repository: scope.repository,
    target: scope.target,
    kind,
    payload,
  } as RecordDraft
  const parsed = buildRecord(draft, contextInputs)
  if (!parsed.ok)
    throw new Error(`fix canonical ${kind} rejected: ${parsed.diagnostics.map((item) => item.code).join(',')}`)
  return parsed.value as FixRecord
}

export async function publish(
  publisher: RecordPublisher,
  item: FixRecord,
  canPublish?: () => boolean,
): Promise<FixActionResult<FixRecord>> {
  if (!isRecordId(item.recordId)) return failure('record-id-invalid')
  const saved = await publisher.publish(item, canPublish)
  return saved.ok ? { ok: true, value: item } : saved
}
/** Reserve the exact owner envelope before acquiring the destination lease. */
export function reserveFixOwner(identity: FixIdentity, scope: FixScope): ReservedRecordIdentity<'fix-owner'> {
  const recordId = `fix-owner-${randomUUID()}`
  return {
    scope: { repository: scope.repository, target: scope.target },
    kind: 'fix-owner',
    runId: identity.runId,
    operationId: `${identity.operationId}-${recordId}`,
    recordId,
  }
}

/** Reserve a recovery control identity without creating or confirming a journal record. */
export function reserveFixRecovery(identity: FixIdentity, scope: FixScope): ReservedRecordIdentity<'fix-recovery'> {
  const recordId = `fix-recovery-${randomUUID()}`
  return {
    scope: { repository: scope.repository, target: scope.target },
    kind: 'fix-recovery',
    runId: identity.runId,
    operationId: `${identity.operationId}-${recordId}`,
    recordId,
  }
}

export type OperatorRequestReservation = {
  source: ReservedRecordIdentity<'contribution'>
  request: ReservedRecordIdentity<'fix-request'>
}

export function reserveOperatorRequest(identity: FixIdentity, scope: FixScope): OperatorRequestReservation {
  const sourceId = identity.nextRecordId('contribution')
  const requestId = identity.nextRecordId('fix-request')
  const recordScope = { repository: scope.repository, target: scope.target }
  return {
    source: {
      scope: recordScope,
      kind: 'contribution',
      runId: identity.runId,
      operationId: `${identity.operationId}-${sourceId}`,
      recordId: sourceId,
    },
    request: {
      scope: recordScope,
      kind: 'fix-request',
      runId: identity.runId,
      operationId: `${identity.operationId}-${requestId}`,
      recordId: requestId,
    },
  }
}

export async function publishOperatorRequest(
  publisher: RecordPublisher,
  identity: FixIdentity,
  target: FixScope & { candidateGitSHA: string | null },
  input: {
    rawOperatorRequest: Json
    publishBinding: PublishBinding
    scope: string
    existingReviewId: string | null
    contextInputs: readonly string[]
    originalSpec: OwnSpecRef
  },
  reservation: OperatorRequestReservation,
  signal?: AbortSignal,
): Promise<FixActionResult<{ source: FixRecord; request: FixRecord }>> {
  const validReservation = (value: ReservedRecordIdentity<string>, kind: string) =>
    value.kind === kind &&
    value.scope.repository === target.repository &&
    value.scope.target === target.target &&
    value.runId === identity.runId &&
    isRecordId(value.recordId) &&
    value.operationId === `${identity.operationId}-${value.recordId}`
  if (
    !validReservation(reservation.source, 'contribution') ||
    !validReservation(reservation.request, 'fix-request') ||
    reservation.source.recordId === reservation.request.recordId
  )
    return failure('fix-request-reservation-invalid')
  const source = record(
    identity,
    target,
    'contribution',
    {
      content: 'operator-request',
      inventoryId: null,
      host: { origin: 'operator', phase: 'fix', role: 'operator', slotId: null, chunk: null, childId: null },
      rawAttempts: [
        capturedSubmission({
          operatorRequest: input.rawOperatorRequest,
          publishBinding: input.publishBinding,
          candidateGitSHA: target.candidateGitSHA,
        }),
      ],
      native: null,
      structured: null,
      findings: null,
    },
    [],
    reservation.source.recordId,
  )
  if (signal?.aborted) return failure('fix-run-interrupted-cleanup-unproven')
  const savedSource = await publish(publisher, source)
  if (!savedSource.ok) return savedSource
  if (signal?.aborted) return failure('fix-run-interrupted-cleanup-unproven')
  const request = record(
    identity,
    target,
    'fix-request',
    {
      requestContributionId: source.recordId,
      existingReviewId: input.existingReviewId,
      scope: input.scope,
      originalSpec: input.originalSpec,
      landing: false,
    },
    [source.recordId, ...input.contextInputs],
    reservation.request.recordId,
  )
  const savedRequest = await publish(publisher, request)
  if (!savedRequest.ok) return savedRequest
  return { ok: true, value: { source, request } }
}
