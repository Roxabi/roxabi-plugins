import type { Scope } from './record-values.ts'

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

/** Canonical records are immutable only when every GitHub-native part is unedited. Empty parts are not a read-back. */
export function recordIntegrity(
  parts: readonly NativeRecordPart[],
  { kind, recordId }: Pick<RecordIdentity, 'kind' | 'recordId'>,
): RecordIntegrityRefusal | null {
  if (parts.length === 0) {
    return { reason: 'record-unreadable', detail: `${kind} record ${recordId} has no native parts` }
  }
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
