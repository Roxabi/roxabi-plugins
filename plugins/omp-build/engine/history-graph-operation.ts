import type { DecodedHistory } from './history-schema.ts'
import { diagnostic } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Diagnostic } from './record-values.ts'

type Operation = DecodedHistory['operations'][number]

export function incompleteOperation(operation: Operation, diagnostics: Diagnostic[]): boolean {
  if (operation.status === 'complete' && operation.record !== null) return false
  diagnostics.push(
    diagnostic(
      operation.status === 'legacy' ? 'legacy-format' : operation.status,
      `Operation ${operation.operationId ?? 'unknown'} is not a complete canonical record`,
    ),
  )
  return true
}

export function refuseOperationIdentity(operation: Operation, diagnostics: Diagnostic[]): void {
  const record = operation.record
  if (record === null) return
  if (
    operation.operationId !== record.operationId ||
    operation.recordId !== record.recordId ||
    operation.kind !== record.kind
  ) {
    diagnostics.push(diagnostic('unbound', `Observed operation metadata does not identify record ${record.recordId}`))
  }
}

function missingNativeId(operation: Operation): boolean {
  return (
    operation.parts.length === 0 || operation.parts.some((part) => part.nativeId === null || part.nativeId.length === 0)
  )
}

export function refuseMissingNativeIdentity(operation: Operation, diagnostics: Diagnostic[]): void {
  const record = operation.record
  if (record === null) return
  if (missingNativeId(operation))
    diagnostics.push(diagnostic('unbound', `Record ${record.recordId} has no native identity`))
}

function authorAllowed(operation: Operation, history: DecodedHistory, author: string | null): boolean {
  if (author === history.source.expectedAuthor) return true
  return operation.record?.kind === 'stop' && history.source.stopAuthor !== null && author === history.source.stopAuthor
}

export function refuseUnauthorizedAuthor(
  operation: Operation,
  history: DecodedHistory,
  diagnostics: Diagnostic[],
): void {
  if (operation.parts.some((part) => !authorAllowed(operation, history, part.author))) {
    diagnostics.push(diagnostic('unbound', `Operation ${operation.operationId} has an unauthorized native author`))
  }
}

function sameRecord(left: CanonicalRecord, right: CanonicalRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function refuseDuplicateOperation(
  operation: Operation,
  operationsById: Map<string, CanonicalRecord>,
  recordsById: Map<string, CanonicalRecord>,
  diagnostics: Diagnostic[],
): void {
  const record = operation.record
  if (record === null) return
  const priorOperation = operationsById.get(record.operationId)
  const priorRecord = recordsById.get(record.recordId)
  if (priorOperation !== undefined && !sameRecord(priorOperation, record)) {
    diagnostics.push(duplicateDiagnostic(record))
    return
  }
  if (priorRecord !== undefined && !sameRecord(priorRecord, record)) diagnostics.push(duplicateDiagnostic(record))
}

function duplicateDiagnostic(record: CanonicalRecord): Diagnostic {
  return diagnostic(
    'duplicate-reference',
    `Operation ${record.operationId} or record ${record.recordId} appears more than once with different content`,
  )
}
