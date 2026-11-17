import { canonicalValueDigest } from './action-input.ts'
import type { DecodedHistory } from './history-schema.ts'
import type { ExternalRecordRef } from './record-references.ts'

export type ContextHandoffHistoryCut = {
  scope: DecodedHistory['source']['scope']
  count: number
  last: { operationId: string | null; recordId: string | null; kind: string | null } | null
}

export function contextHandoffHistoryCut(histories: readonly DecodedHistory[]): ContextHandoffHistoryCut[] {
  return histories.map((history) => {
    const last = history.operations.at(-1)
    return {
      scope: history.source.scope,
      count: history.operations.length,
      last: last === undefined ? null : { operationId: last.operationId, recordId: last.recordId, kind: last.kind },
    }
  })
}

/** Reconstruct and validate the exact historical operation prefix. */
export function contextHandoffPrefixHistories(
  histories: readonly DecodedHistory[],
  cuts: readonly ContextHandoffHistoryCut[],
): DecodedHistory[] | null {
  const prefix: DecodedHistory[] = []
  for (const cut of cuts) {
    const matches = histories.filter(
      (history) =>
        history.source.scope.repository === cut.scope.repository && history.source.scope.target === cut.scope.target,
    )
    const history = matches[0]
    if (
      matches.length !== 1 ||
      history === undefined ||
      !history.source.complete ||
      !Number.isInteger(cut.count) ||
      cut.count < 0 ||
      history.operations.length < cut.count
    )
      return null
    const operations = history.operations.slice(0, cut.count)
    const last = operations.at(-1)
    const identity =
      last === undefined ? null : { operationId: last.operationId, recordId: last.recordId, kind: last.kind }
    if (canonicalValueDigest(identity) !== canonicalValueDigest(cut.last)) return null
    prefix.push({ ...history, operations })
  }
  if (new Set(cuts.map((cut) => `${cut.scope.repository}\0${cut.scope.target}`)).size !== cuts.length) return null
  return prefix
}

/** Digest a reconstructed prefix; later operations cannot rewrite the captured authority. */
export function contextHandoffPrefixDigest(
  histories: readonly DecodedHistory[],
  cuts: readonly ContextHandoffHistoryCut[],
): string | null {
  const prefix = contextHandoffPrefixHistories(histories, cuts)
  return prefix === null ? null : contextHandoffHistoryDigest(prefix)
}

/** Digest the authority cut, excluding only explicitly identified newly published records. */
export function contextHandoffHistoryDigest(
  histories: readonly DecodedHistory[],
  excluded: readonly ExternalRecordRef[] = [],
): string {
  const projection = histories.map((history) => ({
    scope: history.source.scope,
    expectedAuthor: history.source.expectedAuthor,
    stopAuthor: history.source.stopAuthor,
    complete: history.source.complete,
    sourceDiagnostics: history.source.diagnostics,
    diagnostics: history.diagnostics,
    operations: history.operations.filter(
      (operation) =>
        !excluded.some(
          (ref) =>
            ref.scope.repository === history.source.scope.repository &&
            ref.scope.target === history.source.scope.target &&
            ref.recordId === operation.recordId &&
            ref.kind === operation.kind,
        ),
    ),
  }))
  projection.sort((left, right) =>
    `${left.scope.repository}\0${left.scope.target}`.localeCompare(`${right.scope.repository}\0${right.scope.target}`),
  )
  return canonicalValueDigest(projection)
}

/** A pre-delivery handoff permits only the freshly observed absence of a PR binding. */
export function contextHandoffAbsentBindingDigest(): string {
  return canonicalValueDigest({ kind: 'absent', number: null })
}
