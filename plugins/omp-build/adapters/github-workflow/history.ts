import { canonicalValueDigest } from '../../engine/action-input.ts'
import { fixRecoveryDiscoveryScopes } from '../../engine/fix-recovery-discovery.ts'
import type { DecodedHistory, History } from '../../engine/history-schema.ts'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import type { Diagnostic, Scope } from '../../engine/record-values.ts'
import { decodeHistory, projectRecoveryHistories } from '../github/history-codec.ts'
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
    collection.diagnostics.push(...history.source.diagnostics)
    collectCompleteHistoryOperations(history, collection)
    collection.diagnostics.push(...history.diagnostics)
  }
  return collection
}

export function validateComposedWorkflowHistories(
  histories: readonly DecodedHistory[],
  recoverySources: readonly DecodedHistory[] = histories,
):
  | { ok: true; records: CanonicalRecord[] }
  | { ok: false; reason: 'incomplete' | 'ambiguous'; diagnostics: Diagnostic[] } {
  const projected = projectRecoveryHistories(recoverySources)
  if (!projected.ok) return { ok: false, reason: 'ambiguous', diagnostics: projected.diagnostics }
  const strict: DecodedHistory[] = []
  for (const history of histories) {
    const matches = projected.value.filter(
      (item) =>
        item.source.scope.repository === history.source.scope.repository &&
        item.source.scope.target === history.source.scope.target,
    )
    if (matches.length !== 1 || matches[0] === undefined)
      return {
        ok: false,
        reason: 'ambiguous',
        diagnostics: [diagnostic('ambiguous', 'Recovery evidence does not uniquely include a strict history scope')],
      }
    strict.push(matches[0])
  }
  const collected = collectRecords(strict)
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

async function expandRecoverySources(
  scopes: readonly Scope[],
  options: GitHubOptions,
  result: { histories: DecodedHistory[]; failures: Diagnostic[]; unreadable: boolean },
): Promise<void> {
  const attempted = new Set(scopes.map((scope) => `${scope.repository}\0${scope.target}`))
  for (const history of result.histories) {
    const records = history.operations.flatMap((operation) =>
      operation.authority !== 'foreign' && operation.status === 'complete' && operation.record?.kind === 'fix-recovery'
        ? [operation.record]
        : [],
    )
    const pending = fixRecoveryDiscoveryScopes(records).filter((scope) => {
      const key = `${scope.repository}\0${scope.target}`
      if (attempted.has(key)) return false
      attempted.add(key)
      return true
    })
    if (pending.length === 0) continue
    const next = collectReadOutcomes(pending, await readSources(pending, options))
    result.histories.push(...next.histories)
    result.failures.push(...next.failures)
    result.unreadable ||= next.unreadable
  }
}

function changedRecoverySource(
  histories: readonly DecodedHistory[],
  knownHistories: readonly DecodedHistory[],
): boolean {
  for (const observed of histories) {
    const known = knownHistories.filter(
      (entry) =>
        entry.source.scope.repository === observed.source.scope.repository &&
        entry.source.scope.target === observed.source.scope.target,
    )
    if (known.length > 1) return true
    const previous = known[0]
    if (previous !== undefined && canonicalValueDigest(previous.source) !== canonicalValueDigest(observed.source))
      return true
  }
  return false
}

/**
 * Compose only the linked scopes actually required. Scopes stay opaque outside
 * this adapter; callers pass Scope values from githubScope / native association.
 */
export async function readComposedWorkflowHistory(
  scopes: readonly Scope[],
  options: GitHubOptions,
  knownHistories: readonly DecodedHistory[] = [],
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
  const first = collectReadOutcomes(scopes, await readSources(scopes, options))
  const requestedHistories = [...first.histories]
  await expandRecoverySources(scopes, options, first)
  const { histories, failures, unreadable } = first
  if (changedRecoverySource(histories, knownHistories))
    return {
      ok: false,
      reason: 'ambiguous',
      diagnostics: [diagnostic('ambiguous', 'Recovery source changed between native observations')],
      histories: requestedHistories,
    }
  const validated = validateComposedWorkflowHistories(requestedHistories, histories)
  if (failures.length > 0)
    return {
      ok: false,
      reason:
        !validated.ok && validated.reason === 'ambiguous' ? 'ambiguous' : unreadable ? 'unreadable' : 'incomplete',
      diagnostics: [...failures, ...(!validated.ok ? validated.diagnostics : [])],
      histories: requestedHistories,
    }
  if (!validated.ok)
    return { ok: false, reason: validated.reason, diagnostics: validated.diagnostics, histories: requestedHistories }
  const projected = projectRecoveryHistories(histories)
  if (!projected.ok)
    return { ok: false, reason: 'ambiguous', diagnostics: projected.diagnostics, histories: requestedHistories }
  return {
    ok: true,
    scopes: [...scopes],
    histories: projected.value.slice(0, requestedHistories.length),
    records: validated.records,
  }
}
