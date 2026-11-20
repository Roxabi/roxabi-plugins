import type { DecodedHistory } from '../../engine/history-schema.ts'
import { recordIntegrity } from '../../engine/record-integrity.ts'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import { decodeHistory } from '../github/history-codec.ts'

export type WriterRetryObservation = { record: CanonicalRecord; observed: DecodedHistory }

function matchingRetainedParts(
  history: DecodedHistory,
  observed: DecodedHistory,
  record: CanonicalRecord,
  own: DecodedHistory['operations'][number],
  parts: Set<string>,
): boolean {
  const matching = history.operations.filter(
    (operation) => operation.authority !== 'foreign' && operation.operationId === record.operationId,
  )
  return (
    matching.length === 1 &&
    JSON.stringify(matching[0]) === JSON.stringify(own) &&
    JSON.stringify(history.source.comments.filter((comment) => parts.has(comment.locator))) ===
      JSON.stringify(observed.source.comments.filter((comment) => parts.has(comment.locator)))
  )
}

/** Remove only the canonical writer's exact retained incomplete frames from its causal cut. */
export function projectWriterRetryHistory(
  history: DecodedHistory,
  retry: WriterRetryObservation,
): DecodedHistory | null {
  const { record, observed } = retry
  if (record.kind !== 'action-receipt' || record.payload.phase !== 'start') return null
  if (history.source.scope.repository !== record.repository || history.source.scope.target !== record.target)
    return history
  if (observed.source.scope.repository !== record.repository || observed.source.scope.target !== record.target)
    return null
  if (
    !history.source.complete ||
    !observed.source.complete ||
    history.source.expectedAuthor !== observed.source.expectedAuthor ||
    history.source.stopAuthor !== observed.source.stopAuthor
  )
    return null
  if (JSON.stringify(history.source) !== JSON.stringify(observed.source)) return null
  const own = observed.operations.filter(
    (operation) => operation.authority !== 'foreign' && operation.operationId === record.operationId,
  )
  if (
    own.length !== 1 ||
    own[0]?.status !== 'incomplete' ||
    own[0].recordId !== record.recordId ||
    own[0].kind !== record.kind
  )
    return null
  if (recordIntegrity(own[0].parts, record) !== null) return null
  const parts = new Set(own[0].parts.map((part) => part.locator))
  if (parts.size === 0 || parts.size !== own[0].parts.length) return null
  if (!matchingRetainedParts(history, observed, record, own[0], parts)) return null
  return decodeHistory({
    ...history.source,
    comments: history.source.comments.filter((comment) => !parts.has(comment.locator)),
  })
}
