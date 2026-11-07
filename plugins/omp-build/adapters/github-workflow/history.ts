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
  const key = `${record.repository}\0${record.target}\0${record.recordId}`
  const existing = collection.byRecordId.get(key)
  if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(record)) {
    collection.diagnostics.push(
      diagnostic(
        'ambiguous',
        `Record ${record.recordId} has conflicting complete publications at ${record.repository} ${record.target}`,
      ),
    )
    return
  }
  if (existing === undefined) {
    collection.byRecordId.set(key, record)
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

async function readSources(scopes: readonly Scope[], options: GitHubOptions): Promise<PromiseSettledResult<History>[]> {
  const outcomes: PromiseSettledResult<History>[] = []
  for (let index = 0; index < scopes.length; index += 2) {
    const pair = scopes.slice(index, index + 2)
    outcomes.push(...(await Promise.allSettled(pair.map((scope) => readGitHubHistory(scope, options)))))
  }
  return outcomes
}

function collectReadOutcomes(
  scopes: readonly Scope[],
  outcomes: PromiseSettledResult<History>[],
): { histories: DecodedHistory[]; failures: Diagnostic[]; unreadable: boolean } {
  const histories: DecodedHistory[] = []
  const failures: Diagnostic[] = []
  let unreadable = false
  for (let index = 0; index < scopes.length; index += 1) {
    const scope = scopes[index]
    const outcome = outcomes[index]
    if (outcome.status === 'rejected') {
      unreadable = true
      const detail =
        outcome.reason instanceof GitHubHistoryReadError
          ? outcome.reason.diagnostics
          : [diagnostic('github-read-failed', String(outcome.reason))]
      failures.push(diagnostic('incomplete', `Cannot read history for ${scope.repository} ${scope.target}`), ...detail)
      continue
    }
    const source = outcome.value
    histories.push(decodeHistory(source))
    if (!source.complete) {
      unreadable = true
      failures.push(
        diagnostic('incomplete', `Native history for ${scope.repository} ${scope.target} is incomplete`),
        ...source.diagnostics,
      )
    }
  }
  return { histories, failures, unreadable }
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
  if (new Set(scopes.map((scope) => `${scope.repository}\0${scope.target}`)).size !== scopes.length) {
    return {
      ok: false,
      reason: 'ambiguous',
      diagnostics: [diagnostic('ambiguous', 'Composed workflow history received duplicate scopes')],
      histories: [],
    }
  }
  const { histories, failures, unreadable } = collectReadOutcomes(scopes, await readSources(scopes, options))
  const validated = validateComposedWorkflowHistories(histories)
  if (failures.length > 0)
    return {
      ok: false,
      reason:
        !validated.ok && validated.reason === 'ambiguous' ? 'ambiguous' : unreadable ? 'unreadable' : 'incomplete',
      diagnostics: [...failures, ...(!validated.ok ? validated.diagnostics : [])],
      histories,
    }
  if (!validated.ok) return { ok: false, reason: validated.reason, diagnostics: validated.diagnostics, histories }
  return { ok: true, scopes: [...scopes], histories, records: validated.records }
}
