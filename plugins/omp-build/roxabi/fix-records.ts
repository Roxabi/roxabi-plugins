import type { Json, RecordDraft } from '../dist/contracts.js'
import { buildRecord } from '../dist/contracts.js'
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
  },
  signal?: AbortSignal,
): Promise<FixActionResult<{ source: FixRecord; request: FixRecord }>> {
  const source = record(identity, target, 'contribution', {
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
  })
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
      landing: false,
    },
    [source.recordId, ...input.contextInputs],
  )
  const savedRequest = await publish(publisher, request)
  if (!savedRequest.ok) return savedRequest
  return { ok: true, value: { source, request } }
}
