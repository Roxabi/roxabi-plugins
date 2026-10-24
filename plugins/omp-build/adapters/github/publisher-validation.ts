import type { DecodedHistory, OperationRead } from '../../engine/history-schema.ts'
import { parseRecord } from '../../engine/record-construction.ts'
import { stopBotMayAuthor } from '../../engine/record-references.ts'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import type { Diagnostic } from '../../engine/record-values.ts'
import type { GitHubOptions } from './types.ts'
import { diagnostic, GitHubHistoryReadError } from './types.ts'

export type PublicationFailure = {
  status: 'uncertain' | 'refused'
  history: DecodedHistory
  diagnostics: Diagnostic[]
}

export function sameOperation(record: CanonicalRecord, operation: OperationRead): boolean {
  const parsed = parseRecord(record)
  return (
    parsed.ok &&
    operation.operationId === parsed.value.operationId &&
    operation.status === 'complete' &&
    operation.record !== null &&
    JSON.stringify(parsed.value) === JSON.stringify(operation.record)
  )
}

export function publicationReadDiagnostics(error: unknown): Diagnostic[] {
  return error instanceof GitHubHistoryReadError
    ? error.diagnostics
    : [diagnostic('github-read-failed', error instanceof Error ? error.message : String(error))]
}

export function publicationAuthorizationDiagnostics(
  record: CanonicalRecord,
  options: GitHubOptions,
  expectedAuthor: string,
  writer: string,
  stopAuthor: string | null,
): Diagnostic[] | null {
  if (options.writeAuthor !== undefined && options.writeAuthor !== writer) {
    return [
      diagnostic(
        'native-author-mismatch',
        `Authenticated GitHub writer ${writer} is not configured writer ${options.writeAuthor}`,
      ),
    ]
  }
  if (writer === expectedAuthor || (writer === stopAuthor && stopBotMayAuthor([record.kind]))) return null
  return [diagnostic('native-author-mismatch', `GitHub writer ${writer} is not authorized for ${record.kind}`)]
}

export function operationConflictDiagnostics(
  record: CanonicalRecord,
  sameId: readonly OperationRead[],
  incomplete: readonly OperationRead[],
): Diagnostic[] | null {
  if (
    sameId.length === incomplete.length &&
    !incomplete.some((operation) => operation.recordId !== record.recordId || operation.kind !== record.kind)
  ) {
    return null
  }
  return [
    diagnostic(
      'operation-conflict',
      `Operation ${record.operationId} is already present but does not match this record`,
    ),
  ]
}

export function retainedPartConflictDiagnostics(
  record: CanonicalRecord,
  incomplete: readonly OperationRead[],
  expectedBodies: ReadonlySet<string>,
): Diagnostic[] | null {
  const retainedBodies = incomplete.flatMap((operation) => operation.parts.map((part) => part.body))
  if (!retainedBodies.some((body) => !expectedBodies.has(body))) return null
  return [
    diagnostic(
      'operation-conflict',
      `Operation ${record.operationId} has publication parts that differ from this record`,
    ),
  ]
}

export function publicationFailure(
  status: 'uncertain' | 'refused',
  history: DecodedHistory,
  diagnostics: Diagnostic[],
): PublicationFailure {
  return { status, history, diagnostics }
}
