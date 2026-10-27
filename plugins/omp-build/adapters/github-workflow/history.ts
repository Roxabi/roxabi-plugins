import type { DecodedHistory, History } from '../../engine/history-schema.ts'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import type { Diagnostic, Scope } from '../../engine/record-values.ts'
import { decodeHistory } from '../github/history-codec.ts'
import { readGitHubHistory } from '../github/transport.ts'
import { diagnostic, GitHubHistoryReadError, type GitHubOptions } from '../github/types.ts'
import type { ComposedWorkflowHistory } from './types.ts'

type RecordCollection = {
  records: CanonicalRecord[]
  diagnostics: Diagnostic[]
  byRecordId: Map<string, CanonicalRecord>
}

function incompleteOperationDiagnostic(
  history: DecodedHistory,
  operation: DecodedHistory['operations'][number],
): Diagnostic | null {
  if (operation.status !== 'incomplete' && operation.status !== 'conflict') return null
  return diagnostic(
    operation.status === 'incomplete' ? 'incomplete' : 'ambiguous',
    `Operation ${operation.operationId ?? 'unknown'} on ${history.source.scope.target} is ${operation.status}`,
  )
}

function appendCompleteRecord(record: CanonicalRecord, collection: RecordCollection): void {
  const existing = collection.byRecordId.get(record.recordId)
  if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(record)) {
    collection.diagnostics.push(
      diagnostic('ambiguous', `Record ${record.recordId} has conflicting complete publications across scopes`),
    )
    return
  }
  if (existing === undefined) {
    collection.byRecordId.set(record.recordId, record)
    collection.records.push(record)
  }
}

function collectCompleteHistoryOperations(history: DecodedHistory, collection: RecordCollection): void {
  for (const operation of history.operations) {
    if (operation.authority === 'foreign') continue
    const incomplete = incompleteOperationDiagnostic(history, operation)
    if (incomplete !== null) {
      collection.diagnostics.push(incomplete)
      continue
    }
    if (operation.status !== 'complete' || operation.record === null) continue
    appendCompleteRecord(operation.record, collection)
  }
}

function collectRecords(histories: readonly DecodedHistory[]): {
  records: CanonicalRecord[]
  diagnostics: Diagnostic[]
} {
  const collection: RecordCollection = { records: [], diagnostics: [], byRecordId: new Map() }
  for (const history of histories) {
    if (!history.source.complete) {
      collection.diagnostics.push(
        diagnostic('incomplete', `History for ${history.source.scope.target} is not a complete native read`),
      )
      continue
    }
    collectCompleteHistoryOperations(history, collection)
    collection.diagnostics.push(...history.diagnostics)
  }
  return collection
}

export function validateComposedWorkflowHistories(
  histories: readonly DecodedHistory[],
):
  | { ok: true; records: CanonicalRecord[] }
  | { ok: false; reason: 'incomplete' | 'ambiguous'; diagnostics: Diagnostic[] } {
  const collected = collectRecords(histories)
  const blocking = collected.diagnostics.filter(
    (entry) => entry.code === 'incomplete' || entry.code === 'ambiguous' || entry.code === 'conflicting-duplicate',
  )
  if (blocking.length === 0) return { ok: true, records: collected.records }
  return {
    ok: false,
    reason: blocking.some((entry) => entry.code === 'ambiguous' || entry.code === 'conflicting-duplicate')
      ? 'ambiguous'
      : 'incomplete',
    diagnostics: collected.diagnostics,
  }
}

/**
 * Compose only the linked scopes actually required. Scopes stay opaque outside
 * this adapter; callers pass Scope values from githubScope / native association.
 */
export async function readComposedWorkflowHistory(
  scopes: readonly Scope[],
  options: GitHubOptions,
): Promise<ComposedWorkflowHistory> {
  if (scopes.length === 0) {
    return {
      ok: false,
      reason: 'incomplete',
      diagnostics: [diagnostic('incomplete', 'Composed workflow history requires at least one scope')],
      histories: [],
    }
  }
  if (new Set(scopes.map((scope) => scope.target)).size !== scopes.length) {
    return {
      ok: false,
      reason: 'ambiguous',
      diagnostics: [diagnostic('ambiguous', 'Composed workflow history received duplicate scopes')],
      histories: [],
    }
  }
  const histories: DecodedHistory[] = []
  try {
    for (const scope of scopes) {
      const source: History = await readGitHubHistory(scope, options)
      if (!source.complete) {
        return {
          ok: false,
          reason: 'incomplete',
          diagnostics: [diagnostic('incomplete', `Native history for ${scope.target} is incomplete`)],
          histories,
          evidence: { scope },
        }
      }
      histories.push(decodeHistory(source))
    }
  } catch (error) {
    const diagnostics =
      error instanceof GitHubHistoryReadError
        ? error.diagnostics
        : [diagnostic('github-read-failed', error instanceof Error ? error.message : String(error))]
    return { ok: false, reason: 'unreadable', diagnostics, histories }
  }
  const validated = validateComposedWorkflowHistories(histories)
  if (!validated.ok) return { ok: false, reason: validated.reason, diagnostics: validated.diagnostics, histories }
  return { ok: true, scopes: [...scopes], histories, records: validated.records }
}
