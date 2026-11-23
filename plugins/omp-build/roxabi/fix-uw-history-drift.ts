import { decodeHistory, projectRecoveryHistories } from '../dist/contracts.js'
import type { DecodedHistory } from '../engine/history-schema.ts'
import { type CausalResult, causalFailure } from './causal-refusal.ts'

export type HistoryEntry = { history: DecodedHistory; cohort: string }
export type HistoryDifference = HistoryEntry & { previous: HistoryEntry }

function firstDifferentField(left: unknown, right: unknown, path = '$'): string | null {
  if (JSON.stringify(left) === JSON.stringify(right)) return null
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return path
  const entries = new Map(Object.entries(right))
  for (const [key, value] of Object.entries(left)) {
    if (!entries.has(key)) return `${path}.${key}`
    const different = firstDifferentField(value, entries.get(key), `${path}.${key}`)
    if (different !== null) return different
    entries.delete(key)
  }
  return entries.size > 0 ? `${path}.${entries.keys().next().value}` : `${path} (serialization order)`
}

function historyObservationDetail(history: DecodedHistory, cohort: string): string {
  const source = history.source
  return `${cohort}:complete=${source.complete};stopAuthor=${source.stopAuthor ?? 'null'};sourceDiagnostics=${source.diagnostics.map((item) => item.code).join(',')};historyDiagnostics=${history.diagnostics.map((item) => item.code).join(',')}`
}

export function observationDrift(
  history: DecodedHistory,
  cohort: string,
  previous: HistoryEntry | undefined,
): CausalResult<never> {
  const scope = history.source.scope
  return causalFailure(
    'fix-own-uw-unsettled',
    'fix-history-observation-drift',
    `scope=${scope.repository}:${scope.target}`,
    historyObservationDetail(history, cohort),
    ...(previous === undefined
      ? []
      : [
          historyObservationDetail(previous.history, previous.cohort),
          `different=${firstDifferentField(previous.history, history) ?? 'none'}`,
        ]),
  )
}

export function reconcileProjectedDifferences(
  histories: Map<string, HistoryEntry>,
  different: HistoryDifference[],
): CausalResult<true> {
  const raw = [...histories.values()].map((entry) => decodeHistory(entry.history.source))
  const projected = projectRecoveryHistories(raw)
  if (!projected.ok)
    return causalFailure(
      'fix-own-uw-unsettled',
      ...projected.diagnostics.flatMap((item) => [item.code, `${item.code}:${item.message}`]),
    )
  for (const item of different) {
    const index = raw.findIndex(
      (candidate) =>
        candidate.source.scope.repository === item.history.source.scope.repository &&
        candidate.source.scope.target === item.history.source.scope.target,
    )
    const allowed = [raw[index], projected.value[index]].map((candidate) => JSON.stringify(candidate))
    if (!allowed.includes(JSON.stringify(item.history)) || !allowed.includes(JSON.stringify(item.previous.history)))
      return observationDrift(item.history, item.cohort, item.previous)
  }
  return { ok: true, value: true }
}
