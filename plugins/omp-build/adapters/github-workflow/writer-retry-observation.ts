import type { DecodedHistory } from '../../engine/history-schema.ts'
import { recordIntegrity } from '../../engine/record-integrity.ts'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import { decodeHistory } from '../github/history-codec.ts'

export type WriterRetryObservation = { record: CanonicalRecord; observed: DecodedHistory }

type Comment = DecodedHistory['source']['comments'][number]

/** A page position cannot identify a write; every retained native ID must identify one raw comment. */
function withoutRetainedParts(history: DecodedHistory, parts: readonly Comment[]): Comment[] | null {
  const ids = new Map<string, boolean>()
  for (const part of parts) {
    const id = part.nativeId
    if (
      !id ||
      part.author !== history.source.expectedAuthor ||
      part.locator !== `${history.source.scope.target}:comment:${id}`
    )
      return null
    ids.set(id, false)
  }
  if (ids.size === 0 || ids.size !== parts.length) return null
  let removed = 0
  const remaining: Comment[] = []
  for (const comment of history.source.comments) {
    const id = comment.nativeId ?? ''
    const seen = ids.get(id)
    if (seen === undefined) remaining.push(comment)
    else {
      if (seen) return null
      ids.set(id, true)
      removed++
    }
  }
  return removed === ids.size ? remaining : null
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
  const matching = history.operations.filter(
    (operation) => operation.authority !== 'foreign' && operation.operationId === record.operationId,
  )
  if (matching.length !== 1 || JSON.stringify(matching[0]) !== JSON.stringify(own[0])) return null
  const comments = withoutRetainedParts(history, own[0].parts)
  return comments === null ? null : decodeHistory({ ...history.source, comments })
}
