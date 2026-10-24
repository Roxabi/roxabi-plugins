import type { CanonicalRecord, DecodedHistory } from '../dist/contracts.js'
import { specDigest } from '../dist/contracts.js'
import type { FixRecord } from './fix-contract.ts'
import { FIX_OPERATION_KIND, type FixCheckpoint, objectValue } from './fix-mandate-types.ts'

export function correctionInventory(record: CanonicalRecord): boolean {
  return record.kind === 'review-attempt' && record.payload.purpose === 'correction'
}

export function pinnedHead(record: CanonicalRecord | undefined): string | null {
  if (record?.kind !== 'contribution') return null
  const raw = record.payload.rawAttempts[0]?.raw
  const pin = objectValue(raw)?.candidateGitSHA
  return typeof pin === 'string' ? pin : null
}

/** A confirmed request may proceed only in its own live dispatch; cold starts remain unresolved. */
export function reconstructFixCheckpoint(
  history: DecodedHistory,
  trustedLiveRequest?: Extract<FixRecord, { kind: 'fix-request' }>,
): FixCheckpoint {
  if (!history.source.complete) {
    return {
      status: 'blocked',
      reason: 'incomplete-history',
      diagnostics: ['fix-history-incomplete'],
      startedRequestIds: [],
    }
  }
  const pending = pendingOperationCheckpoint(history)
  if (pending !== null) return pending
  const records = completedRecords(history)
  if (!(records instanceof Map)) return records
  return checkpointFromRecords(history, records, trustedLiveRequest)
}

function pendingOperationCheckpoint(history: DecodedHistory): FixCheckpoint | null {
  const diagnostics: string[] = []
  const startedRequestIds: string[] = []
  for (const operation of history.operations) {
    const record = operation.record
    const kind = operation.kind ?? record?.kind ?? null
    const fixRelated =
      (kind !== null && FIX_OPERATION_KIND[kind] === true) || (record !== null && correctionInventory(record))
    if (!fixRelated || operation.status === 'complete') continue
    diagnostics.push(`fix-operation-${operation.status}:${kind ?? 'unknown'}`)
    if (record?.kind === 'fix-request') startedRequestIds.push(record.recordId)
  }
  if (diagnostics.length === 0) return null
  const conflict = diagnostics.some(
    (item) => item.includes('conflict') || item.includes('invalid') || item.includes('legacy'),
  )
  return {
    status: 'blocked',
    reason: conflict ? 'conflict' : 'unresolved-effect',
    diagnostics,
    startedRequestIds,
  }
}

function completedRecords(history: DecodedHistory): Map<string, CanonicalRecord> | FixCheckpoint {
  const byId = new Map<string, CanonicalRecord>()
  for (const operation of history.operations) {
    if (operation.status !== 'complete' || !operation.record) continue
    const prior = byId.get(operation.record.recordId)
    if (prior && JSON.stringify(prior) !== JSON.stringify(operation.record)) {
      return {
        status: 'blocked',
        reason: 'conflict',
        diagnostics: [`fix-record-conflict:${operation.record.recordId}`],
        startedRequestIds: [],
      }
    }
    byId.set(operation.record.recordId, operation.record)
  }
  return byId
}

function checkpointFromRecords(
  history: DecodedHistory,
  byId: Map<string, CanonicalRecord>,
  trustedLiveRequest: Extract<FixRecord, { kind: 'fix-request' }> | undefined,
): FixCheckpoint {
  const requests = [...byId.values()].filter((record) => record.kind === 'fix-request')
  const results = [...byId.values()].filter((record) => record.kind === 'fix-result')
  const open = requests.filter(
    (request) =>
      !results.some((result) => result.kind === 'fix-result' && result.payload.requestId === request.recordId),
  )
  if (open.length > 1) {
    return {
      status: 'blocked',
      reason: 'ambiguous',
      diagnostics: ['fix-open-request-ambiguous'],
      startedRequestIds: open.map((request) => request.recordId),
    }
  }
  const request = open[0]
  if (request !== undefined) return openRequestCheckpoint(history, byId, request, trustedLiveRequest)
  if (requests.length === 0) return { status: 'not-started' }
  const last = results.at(-1)
  if (last?.kind !== 'fix-result') {
    return {
      status: 'blocked',
      reason: 'unresolved-effect',
      diagnostics: ['fix-result-missing'],
      startedRequestIds: [],
    }
  }
  const referenced = [
    last.payload.decisionId,
    ...last.payload.correctionResultIds,
    ...last.payload.falsificationResultIds,
    ...last.payload.debtReceiptIds,
  ]
  const missing = referenced.filter((id) => !byId.has(id))
  if (missing.length > 0) {
    return {
      status: 'blocked',
      reason: 'unresolved-effect',
      diagnostics: missing.map((id) => `fix-result-reference-missing:${id}`),
      startedRequestIds: [],
    }
  }
  return {
    status: 'complete',
    requestId: last.payload.requestId,
    resultId: last.recordId,
    candidateGitSHA: last.payload.candidateGitSHA,
  }
}

function openRequestCheckpoint(
  history: DecodedHistory,
  byId: Map<string, CanonicalRecord>,
  request: Extract<CanonicalRecord, { kind: 'fix-request' }>,
  trustedLiveRequest: Extract<FixRecord, { kind: 'fix-request' }> | undefined,
): FixCheckpoint {
  const unresolved: Extract<FixCheckpoint, { status: 'blocked' }> = {
    status: 'blocked',
    reason: 'unresolved-effect',
    diagnostics: [
      `fix-open-request-unresolved:${request.recordId}`,
      `fix-open-request-head:${pinnedHead(byId.get(request.payload.requestContributionId)) ?? 'unpinned'}`,
    ],
    startedRequestIds: [request.recordId],
  }
  return trustedLiveRequestCheckpoint(history, unresolved, trustedLiveRequest)
    ? { status: 'live-owned', requestId: request.recordId }
    : unresolved
}

export function trustedLiveRequestCheckpoint(
  history: DecodedHistory,
  checkpoint: FixCheckpoint,
  trusted: Extract<FixRecord, { kind: 'fix-request' }> | undefined,
): boolean {
  if (
    trusted === undefined ||
    checkpoint.status !== 'blocked' ||
    checkpoint.reason !== 'unresolved-effect' ||
    checkpoint.startedRequestIds.length !== 1 ||
    checkpoint.startedRequestIds[0] !== trusted.recordId ||
    checkpoint.diagnostics.length !== 2 ||
    checkpoint.diagnostics[0] !== `fix-open-request-unresolved:${trusted.recordId}`
  )
    return false
  return history.operations.some(
    (operation) =>
      operation.status === 'complete' &&
      operation.record?.kind === 'fix-request' &&
      JSON.stringify(operation.record) === JSON.stringify(trusted),
  )
}
export function liveBoundSpec(bodies: readonly { body: string }[]): { body: string; digest: string } | null {
  const body = bodies.length === 1 ? bodies[0]?.body : undefined
  if (typeof body !== 'string' || body.length === 0) return null
  return { body, digest: specDigest(body) }
}
