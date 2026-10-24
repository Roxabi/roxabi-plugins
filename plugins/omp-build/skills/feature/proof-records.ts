import { randomUUID } from 'node:crypto'
import {
  buildRecord,
  type CanonicalRecord,
  classifyHistory,
  type DecodedHistory,
  githubScope,
  type Json,
} from '../../dist/contracts.js'
import { isMap, NATIVE_INSTANT, type PrComment, type Producer, type Refusal, refuse } from './proof-base'
import type { Target } from './proof-context'

// ---------------------------------------------------------------------------
// Conserved records: common codec transport, native proof semantics
// ---------------------------------------------------------------------------

type Found = { record: unknown; recordId: string; parts: PrComment[] } | { missing: string } | { unreadable: string }
export type SelectedRecord = Extract<Found, { record: unknown }>

const proofOperationPrefix = (producer: Producer, candidate: string) => `proof:${producer}:${candidate}:`

export function findProofRecord(history: DecodedHistory, producer: Producer, candidate: string): Found {
  const foreignOperationIds = new Set(
    classifyHistory(history)
      .classes.filter((entry) => entry.authority === 'foreign' && entry.operationId !== null)
      .map((entry) => entry.operationId),
  )
  const sourcePosition = new Map(history.source.comments.map((comment, index) => [comment.locator, index]))
  const lastPosition = (parts: (typeof history.operations)[number]['parts']) =>
    Math.max(...parts.map((part) => sourcePosition.get(part.locator) ?? -1))
  const operations = history.operations
    .filter(
      (operation) =>
        operation.operationId?.startsWith(proofOperationPrefix(producer, candidate)) &&
        operation.operationId !== null &&
        !foreignOperationIds.has(operation.operationId),
    )
    .sort((left, right) => lastPosition(left.parts) - lastPosition(right.parts))
  if (!operations.length) {
    const legacy = history.source.comments.some(
      (comment) =>
        comment.author === history.source.expectedAuthor &&
        comment.body.includes(`<!-- omp-build:proof producer=${producer} -->`) &&
        comment.body.includes(`<!-- omp-build:proof-head sha=${candidate}`),
    )
    return legacy
      ? {
          unreadable: `a legacy ${producer} proof record exists for ${candidate}; historical proof framing cannot admit landing`,
        }
      : { missing: `no ${producer} common proof record for candidate ${candidate}` }
  }
  const latest = operations.at(-1)
  if (!latest) return { unreadable: `the latest ${producer} proof operation for ${candidate} is missing` }
  if (latest.status !== 'complete' || latest.record === null)
    return { unreadable: `the latest ${producer} proof operation for ${candidate} is ${latest.status}` }
  if (
    latest.record.kind !== 'proof' ||
    latest.record.payload.candidateGitSHA !== candidate ||
    !isMap(latest.record.payload.data) ||
    latest.record.payload.data.producer !== producer
  )
    return { unreadable: `the latest ${producer} proof operation for ${candidate} has invalid proof data` }
  if (latest.record.recordId.length === 0) {
    return { unreadable: `the latest ${producer} proof operation for ${candidate} has no record id` }
  }
  return {
    record: latest.record.payload.data,
    recordId: latest.record.recordId,
    parts: latest.parts.map((part) => ({
      id: part.nativeId === null ? undefined : Number(part.nativeId),
      author: { login: part.author ?? '' },
      body: part.body,
      ...(part.createdAt === null ? {} : { createdAt: part.createdAt }),
      ...(part.updatedAt === null ? {} : { updatedAt: part.updatedAt }),
    })),
  }
}

export function newProofRecord(
  repository: string,
  pr: number,
  producer: Producer,
  candidate: string,
  data: unknown,
): CanonicalRecord {
  const operationId = `${proofOperationPrefix(producer, candidate)}${randomUUID()}`
  const built = buildRecord({
    version: 1,
    recordId: operationId,
    runId: `proof:${candidate}:${randomUUID()}`,
    operationId,
    repository,
    target: githubScope(repository, pr).target,
    kind: 'proof',
    payload: { candidateGitSHA: candidate, data: data as Json },
  })
  if (!built.ok) {
    throw new Error(`proof record refused: ${built.diagnostics.map((item) => item.code).join(',')}`)
  }
  return built.value
}

/** GitHub's native UTC instants, including a real calendar date; no inferred timestamp. */
function nativeInstant(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || !NATIVE_INSTANT.test(value)) return null
  const time = Date.parse(value)
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== value.slice(0, 19)) return null
  return time
}

/** Acquisition only creates parts: a readable native revision invalidates reuse. */
export function recordIntegrity(parts: PrComment[], producer: Producer): Refusal | null {
  for (const [index, part] of parts.entries()) {
    const created = nativeInstant(part.createdAt)
    const revised = nativeInstant(part.updatedAt)
    if (created === null || revised === null || revised < created) {
      return refuse(
        producer,
        'unreadable',
        `proof part ${index + 1}/${parts.length} has unreadable native creation/revision facts (${JSON.stringify(part.createdAt)}, ${JSON.stringify(part.updatedAt)}); obtain readable GitHub metadata before re-review`,
      )
    }
    if (revised !== created) {
      return refuse(
        producer,
        'unbound',
        `proof part ${index + 1}/${parts.length} was revised after publication; acquire a new producer record, then review the head (skills/feature/proof-records.ts recordIntegrity)`,
      )
    }
  }
  return null
}

/** Every selected native part was published, unmodified, before this approval. */
export function reviewedRecord(parts: PrComment[], target: Target, producer: Producer): Refusal | null {
  const integrity = recordIntegrity(parts, producer)
  if (integrity) return integrity
  const approved = nativeInstant(target.reviewedAt)
  if (approved === null)
    return refuse(
      producer,
      'unjustified',
      `the review of candidate ${target.candidate} has no readable native creation time: re-review the head (skills/feature/proof-records.ts reviewedRecord)`,
    )
  for (const [index, part] of parts.entries()) {
    const created = nativeInstant(part.createdAt)
    if (created === null || created >= approved) {
      return refuse(
        producer,
        'unjustified',
        `proof part ${index + 1}/${parts.length} was published at ${part.createdAt}, not before approving review ${target.reviewedAt}: re-review the same head (skills/feature/proof-records.ts reviewedRecord), reuse the unmodified record without a producer`,
      )
    }
  }
  return null
}
