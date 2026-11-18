import { decodeHistory, encodeRecord } from '../adapters/github/history-codec.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'

const date = '2026-10-27T12:00:00Z'

export function createChildHistoryAppender(histories: readonly DecodedHistory[]) {
  const observedIds = histories
    .flatMap((entry) => entry.source.comments.map((comment) => Number(comment.nativeId)))
    .filter((id) => Number.isSafeInteger(id) && id > 0)
  let nextId = Math.max(0, ...observedIds) + 1
  return (initial: DecodedHistory, records: readonly CanonicalRecord[], external: readonly DecodedHistory[]) => {
    let current = initial
    for (const record of records) {
      if (
        current.operations.some((operation) => operation.recordId === record.recordId && operation.kind === record.kind)
      )
        continue
      const encoded = encodeRecord(record, current.source, null, external)
      if (!encoded.ok) throw new Error(`Child record encoding refused: ${JSON.stringify(encoded.diagnostics)}`)
      const comments = encoded.value.map((body) => {
        const nativeId = String(nextId++)
        return {
          locator: `${current.source.scope.target}:comment:${nativeId}`,
          nativeId,
          body,
          author: 'operator',
          createdAt: date,
          updatedAt: date,
        }
      })
      current = decodeHistory({ ...current.source, comments: [...current.source.comments, ...comments] })
    }
    return current
  }
}
