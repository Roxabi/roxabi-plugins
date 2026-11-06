import {
  type GitHubOptions,
  readCauseHistoryClosure,
  readComposedWorkflowHistory,
  readUwCompletionObservation,
} from '../dist/contracts.js'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import type { ReviewClassCatalogues } from '../engine/review-class-catalogue.ts'
import type { WorkflowCausalContext } from '../engine/workflow-plan.ts'
import { defaultGh } from './feature-engine.ts'
import type { FixActionResult } from './fix-contract.ts'
import { failure } from './fix-contract.ts'
import { withRoxabiGitHubPolicy } from './github-policy.ts'
import { loadReviewClassCatalogues } from './review-class-catalogues.ts'
import type { UwRead } from './uw-contract.ts'
import { createInstalledUwReadPort } from './uw-read-port.ts'

export type FixUwCausalContext = WorkflowCausalContext
type FixHistoryClosure = {
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
): Promise<FixActionResult<FixHistoryClosure>> {
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
): Promise<FixActionResult<WorkflowCausalContext>> {
  if (
    read.causalObservation?.status !== 'complete' ||
    read.causalObservation.histories !== read.histories ||
    read.causalObservation.catalogues !== read.catalogues
  )
    return failure('fix-own-uw-unsettled', 'fix-causal-observation-unavailable')
  if (read.observation.status !== 'complete')
    return failure('fix-own-uw-unsettled', 'fix-completion-observation-unavailable')
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
    return {
      ok: true,
      value: { histories: read.histories, catalogues: read.catalogues, observation: read.observation },
    }
  return collectJointUwCausalContext(read.uw, merged.value, options)
}

/** Obtain the complete joint observation for a known canonical UW, then bind the selected histories. */
export async function readFreshUwCausalContext(
  scope: Scope,
  selected: readonly DecodedHistory[],
  options: GitHubOptions,
): Promise<FixActionResult<FixUwCausalContext>> {
  try {
    const read = await createInstalledUwReadPort({
      cwd: options.cwd,
      gh: options.gh ?? defaultGh(),
      ...(options.readAuthor === undefined ? {} : { readAuthor: options.readAuthor }),
    }).readUw(scope)
    return composeObservedUwCausalContext(read, selected, options)
  } catch {
    return failure('fix-own-uw-unsettled', 'fix-completion-observation-unavailable')
  }
}

export async function extendObservedUwCausalContext(
  previous: WorkflowCausalContext,
  selected: readonly DecodedHistory[],
  options: GitHubOptions,
): Promise<FixActionResult<WorkflowCausalContext>> {
  const merged = mergeFixUwHistories(previous.histories, selected)
  if (!merged.ok) return merged
  if (merged.value.length === previous.histories.length) return { ok: true, value: previous }
  return collectJointUwCausalContext(previous.observation.root, merged.value, options)
}

async function collectJointUwCausalContext(
  root: Scope,
  histories: readonly DecodedHistory[],
  options: GitHubOptions,
): Promise<FixActionResult<WorkflowCausalContext>> {
  const policy = withRoxabiGitHubPolicy(options)
  const observation = await readUwCompletionObservation(
    root,
    policy,
    (observed) => loadReviewClassCatalogues({ histories: observed, cwd: options.cwd, gh: options.gh ?? defaultGh() }),
    [],
    histories,
  )
  if (observation.status !== 'complete')
    return failure('fix-own-uw-unsettled', ...observation.diagnostics.map((item) => item.code))
  return { ok: true, value: { histories: observation.histories, catalogues: observation.catalogues, observation } }
}
