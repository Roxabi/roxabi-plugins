import type { DecodedHistory, OperationRead } from '../../engine/history-schema.ts'
import type { Scope } from '../../engine/record-values.ts'

const NATIVE_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

type NativeRecordPart = { createdAt: string | null | undefined; updatedAt: string | null | undefined }
type RecordIdentity = {
  kind: string
  recordId: string
  scope?: Scope
  repository?: string
  target?: string
}

export type RecordIntegrityRefusal = {
  reason: 'record-unreadable' | 'record-edited'
  detail: string
}

/** GitHub's native UTC instants, including a real calendar date; no inferred timestamp. */
export function nativeInstant(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || !NATIVE_INSTANT.test(value)) return null
  const time = Date.parse(value)
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== value.slice(0, 19)) return null
  return time
}

/** Canonical records are immutable only when every GitHub-native part is unedited. */
export function recordIntegrity(
  parts: readonly NativeRecordPart[],
  { kind, recordId }: Pick<RecordIdentity, 'kind' | 'recordId'>,
): RecordIntegrityRefusal | null {
  for (const [index, part] of parts.entries()) {
    const created = nativeInstant(part.createdAt)
    const updated = nativeInstant(part.updatedAt)
    const identity = `${kind} record ${recordId} part ${index + 1}/${parts.length}`
    if (created === null || updated === null || updated < created) {
      return {
        reason: 'record-unreadable',
        detail: `${identity} has unreadable native creation/revision facts (${JSON.stringify(part.createdAt)}, ${JSON.stringify(part.updatedAt)})`,
      }
    }
    if (updated !== created) return { reason: 'record-edited', detail: `${identity} was revised after publication` }
  }
  return null
}

/** Finds the native operation that published a selected canonical record without another GitHub read. */
export function recordOperation(histories: readonly DecodedHistory[], record: RecordIdentity): OperationRead | null {
  const scope =
    record.scope ??
    (typeof record.repository === 'string' && typeof record.target === 'string'
      ? { repository: record.repository, target: record.target }
      : undefined)
  for (const history of histories) {
    if (
      scope !== undefined &&
      (history.source.scope.repository !== scope.repository || history.source.scope.target !== scope.target)
    )
      continue
    const operation = history.operations.find(
      (entry) => entry.record?.recordId === record.recordId && entry.record.kind === record.kind,
    )
    if (operation !== undefined) return operation
  }
  return null
}
