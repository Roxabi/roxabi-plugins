import { type GitHubOptions, readCauseHistoryClosure, readComposedWorkflowHistory } from '../dist/contracts.js'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { ReviewClassCatalogues } from '../engine/review-class-catalogue.ts'
import type { WithdrawalBarrier } from '../skills/feature/workflow-gate.js'
import { defaultGh } from './feature-engine.ts'
import type { FixActionResult } from './fix-contract.ts'
import { failure } from './fix-contract.ts'
import { withRoxabiGitHubPolicy } from './github-policy.ts'
import { loadReviewClassCatalogues } from './review-class-catalogues.ts'
import type { UwRead } from './uw-contract.ts'

function matchesWithdrawalBarrier(
  comment: DecodedHistory['source']['comments'][number] | undefined,
  barrier: WithdrawalBarrier | undefined,
  scope: DecodedHistory['source']['scope'],
): boolean {
  return (
    barrier !== undefined &&
    comment !== undefined &&
    barrier.record.kind === 'withdraw' &&
    `${scope.repository}#${barrier.record.pullRequest}` === scope.target &&
    comment.nativeId === String(barrier.id) &&
    comment.body === barrier.body &&
    comment.createdAt === barrier.createdAt
  )
}

function matchesWithdrawalHistory(
  previous: DecodedHistory,
  current: DecodedHistory,
  scope: DecodedHistory['source']['scope'],
  barriers: readonly WithdrawalBarrier[],
): boolean {
  const comments = current.source.comments
  const oldComments = previous.source.comments
  if (comments.length !== oldComments.length + barriers.length) return false
  for (let index = 0; index < barriers.length; index++) {
    if (!matchesWithdrawalBarrier(comments[oldComments.length + index], barriers[index], scope)) return false
  }
  const withoutBarriers = {
    ...current,
    source: { ...current.source, comments: comments.slice(0, oldComments.length) },
  }
  return JSON.stringify(previous) === JSON.stringify(withoutBarriers)
}

/** Validate a native reread across our own confirmed withdrawal writes, without accepting other drift. */
export function reconcileWithdrawalHistories(
  before: readonly DecodedHistory[],
  after: readonly DecodedHistory[],
  scope: DecodedHistory['source']['scope'],
  barriers: readonly WithdrawalBarrier[],
): FixActionResult<readonly DecodedHistory[]> {
  const key = (history: DecodedHistory) => `${history.source.scope.repository}\0${history.source.scope.target}`
  const target = `${scope.repository}\0${scope.target}`
  const next = new Map(after.map((history) => [key(history), history]))
  if (next.size !== after.length || new Set(before.map(key)).size !== before.length || before.length !== after.length)
    return failure('fix-own-uw-unsettled', 'fix-history-observation-drift')
  for (const previous of before) {
    const current = next.get(key(previous))
    if (current === undefined || !previous.source.complete || !current.source.complete)
      return failure('fix-own-uw-unsettled', 'fix-history-observation-drift')
    const matches =
      key(previous) === target
        ? matchesWithdrawalHistory(previous, current, scope, barriers)
        : JSON.stringify(previous) === JSON.stringify(current)
    if (!matches) return failure('fix-own-uw-unsettled', 'fix-history-observation-drift')
  }
  if (barriers.length > 0 && !before.some((history) => key(history) === target))
    return failure('fix-own-uw-unsettled', 'fix-history-observation-drift')
  return { ok: true, value: after }
}

export type FixUwCausalContext = {
  histories: readonly DecodedHistory[]
  catalogues: ReviewClassCatalogues
}

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

function observationDrift(
  history: DecodedHistory,
  cohort: string,
  previous: { history: DecodedHistory; cohort: string } | undefined,
): FixActionResult<never> | null {
  if (
    history.source.complete &&
    (previous === undefined || JSON.stringify(previous.history) === JSON.stringify(history))
  )
    return null
  const scope = history.source.scope
  return failure(
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

/** Combine observations only when every shared scope denotes the same complete history. */
export function mergeFixUwHistories(
  observed: readonly DecodedHistory[],
  current: readonly DecodedHistory[],
): FixActionResult<readonly DecodedHistory[]> {
  const histories = new Map<string, { history: DecodedHistory; cohort: string }>()
  for (const cohort of [
    { name: 'observed', histories: observed },
    { name: 'current', histories: current },
  ]) {
    for (const history of cohort.histories) {
      const scope = history.source.scope
      const key = `${scope.repository}\0${scope.target}`
      const previous = histories.get(key)
      const drift = observationDrift(history, cohort.name, previous)
      if (drift !== null) return drift
      if (previous === undefined) histories.set(key, { history, cohort: cohort.name })
    }
  }
  return { ok: true, value: [...histories.values()].map((entry) => entry.history) }
}

/** Build one complete reference-resolution observation without changing parent selection. */
export async function readFixUwCausalContext(
  observed: readonly DecodedHistory[],
  current: readonly DecodedHistory[],
  options: GitHubOptions,
): Promise<FixActionResult<FixUwCausalContext>> {
  const merged = mergeFixUwHistories(observed, current)
  if (!merged.ok) return merged
  const closure = await readCauseHistoryClosure(merged.value, (required) =>
    readComposedWorkflowHistory(required, withRoxabiGitHubPolicy(options)),
  )
  if (!closure.ok) return failure('fix-own-uw-unsettled', ...closure.diagnostics.map((item) => item.code))
  const catalogues = await loadReviewClassCatalogues({
    histories: closure.histories,
    cwd: options.cwd,
    gh: options.gh ?? defaultGh(),
  })
  return { ok: true, value: { histories: closure.histories, catalogues } }
}

/** Reuse only the completed closure and catalogue table of this exact UW observation. */
export async function composeObservedUwCausalContext(
  read: UwRead,
  selected: readonly DecodedHistory[],
  options: GitHubOptions,
): Promise<FixActionResult<FixUwCausalContext>> {
  if (
    read.causalObservation?.status !== 'complete' ||
    read.causalObservation.histories !== read.histories ||
    read.causalObservation.catalogues !== read.catalogues
  )
    return failure('fix-own-uw-unsettled', 'fix-causal-observation-unavailable')
  const scopes = new Set<string>()
  let own = false
  const policy = withRoxabiGitHubPolicy(options)
  for (const history of read.histories) {
    const scope = history.source.scope
    const key = `${scope.repository}\0${scope.target}`
    if (
      scopes.has(key) ||
      !history.source.complete ||
      history.source.stopAuthor !== policy.stopAuthor ||
      (policy.readAuthor !== undefined && history.source.expectedAuthor !== policy.readAuthor)
    )
      return failure('fix-own-uw-unsettled', 'fix-history-observation-drift')
    scopes.add(key)
    if (scope.repository === read.uw.repository && scope.target === read.uw.target) own = true
  }
  if (!own) return failure('fix-own-uw-unsettled', 'fix-causal-own-history-missing')
  const merged = mergeFixUwHistories(read.histories, selected)
  if (!merged.ok) return merged
  if (merged.value.length === read.histories.length)
    return { ok: true, value: { histories: read.histories, catalogues: read.catalogues } }
  return readFixUwCausalContext(merged.value, [], options)
}
