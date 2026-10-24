import type { Json, RecordDraft } from '../dist/contracts.js'
import { buildRecord } from '../dist/contracts.js'
import type { FixActionResult, FixIdentity, FixRecord, FixScope, RecordPublisher } from './fix-contract.ts'
import { failure, isRecordId } from './fix-contract.ts'

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

export async function publish(publisher: RecordPublisher, item: FixRecord): Promise<FixActionResult<FixRecord>> {
  if (!isRecordId(item.recordId)) return failure('record-id-invalid')
  const saved = await publisher.publish(item)
  return saved.ok ? { ok: true, value: item } : saved
}
