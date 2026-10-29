import type { DecodedHistory, OperationRead } from '../../engine/history-schema.ts'
import type { Scope } from '../../engine/record-values.ts'

type RecordIdentity = {
  kind: string
  recordId: string
  scope?: Scope
  repository?: string
  target?: string
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
