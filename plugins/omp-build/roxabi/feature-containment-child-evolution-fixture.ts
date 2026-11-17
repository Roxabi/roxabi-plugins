import { decodeHistory, encodeRecord } from '../adapters/github/history-codec.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'

export function evolveChildHistory(
  child: DecodedHistory,
  histories: readonly DecodedHistory[],
  records: readonly CanonicalRecord[],
) {
  const sourceIds = histories
    .flatMap((entry) => entry.source.comments.map((comment) => Number(comment.nativeId)))
    .filter((id) => Number.isSafeInteger(id) && id > 0)
  let nextId = Math.max(0, ...sourceIds) + 1
  let evolvedChild = child
  for (const record of records) {
    const encoded = encodeRecord(
      record,
      evolvedChild.source,
      null,
      histories.filter((entry) => entry !== child),
    )
    if (!encoded.ok) throw new Error(`Later child record refused: ${JSON.stringify(encoded.diagnostics)}`)
    const appended = encoded.value.map((body) => {
      const nativeId = String(nextId++)
      return {
        locator: `${child.source.scope.target}:comment:${nativeId}`,
        nativeId,
        body,
        author: 'operator',
        createdAt: '2026-12-01T12:00:00Z',
        updatedAt: '2026-12-01T12:00:00Z',
      }
    })
    evolvedChild = decodeHistory({ ...evolvedChild.source, comments: [...evolvedChild.source.comments, ...appended] })
  }
  return histories.map((entry) => (entry === child ? evolvedChild : entry))
}
