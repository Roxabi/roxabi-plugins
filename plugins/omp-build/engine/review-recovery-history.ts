import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope, fail } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Diagnostic } from './record-values.ts'
import type { Result } from './result.ts'

type HistoryOperation = DecodedHistory['operations'][number]

function sameScope(
  left: { repository: string; target: string },
  right: { repository: string; target: string },
): boolean {
  return equalScope(left, right)
}

function recoveryKind(kind: HistoryOperation['kind']): boolean {
  return kind === 'review-attempt' || kind === 'review-interruption' || kind === 'review-replacement-grant'
}

function recoveryRecord(record: CanonicalRecord): boolean {
  return recoveryKind(record.kind)
}

function completeOperation(operation: HistoryOperation): operation is HistoryOperation & { record: CanonicalRecord } {
  return operation.status === 'complete' && operation.record !== null
}

function recoveryOperationDiagnostics(
  operation: HistoryOperation,
  history: DecodedHistory,
  byRecord: Map<string, string>,
  byOperation: Map<string, string>,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  if (!completeOperation(operation)) {
    if (recoveryKind(operation.kind))
      diagnostics.push(
        diagnostic(
          'incomplete',
          `Recovery evidence ${operation.operationId ?? operation.recordId ?? 'unknown'} is partial`,
        ),
      )
    return diagnostics
  }
  const record = operation.record
  if (!recoveryRecord(record)) return diagnostics
  if (
    operation.operationId !== record.operationId ||
    operation.recordId !== record.recordId ||
    operation.kind !== record.kind ||
    !sameScope(record, history.source.scope)
  )
    diagnostics.push(
      diagnostic('unbound', `Recovery operation metadata or scope does not authenticate ${record.recordId}`),
    )
  if (operation.parts.some((part) => part.author !== history.source.expectedAuthor))
    diagnostics.push(diagnostic('unbound', `Recovery record ${record.recordId} has an unauthorized native author`))
  const encoded = JSON.stringify(record)
  const priorRecord = byRecord.get(record.recordId)
  const priorOperation = byOperation.get(record.operationId)
  if (
    (priorRecord !== undefined && priorRecord !== encoded) ||
    (priorOperation !== undefined && priorOperation !== encoded)
  )
    diagnostics.push(diagnostic('conflict', `Recovery record ${record.recordId} has contradictory duplicate evidence`))
  byRecord.set(record.recordId, encoded)
  byOperation.set(record.operationId, encoded)
  return diagnostics
}

/** Authenticate complete recovery evidence and retain unique complete records. */
export function trustedRecoveryRecords(history: DecodedHistory): Result<CanonicalRecord[]> {
  const diagnostics = [...history.diagnostics, ...history.source.diagnostics]
  if (!history.source.complete) diagnostics.push(diagnostic('incomplete', 'Recovery history pagination is incomplete'))
  const byRecord = new Map<string, string>()
  const byOperation = new Map<string, string>()
  for (const operation of history.operations)
    diagnostics.push(...recoveryOperationDiagnostics(operation, history, byRecord, byOperation))
  if (diagnostics.length > 0) return fail(diagnostics)
  const records = history.operations.flatMap((operation) => (completeOperation(operation) ? [operation.record] : []))
  return { ok: true, value: [...new Map(records.map((record) => [record.recordId, record])).values()] }
}
