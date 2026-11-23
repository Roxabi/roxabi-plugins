import { type GitHubOptions, readUwCompletionObservation } from '../dist/contracts.js'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import type { WorkflowCausalContext } from '../engine/workflow-plan.ts'
import { type CausalResult, causalFailure, observationReasons, reasonLine } from './causal-refusal.ts'
import { defaultGh } from './feature-engine.ts'
import {
  type HistoryDifference,
  type HistoryEntry,
  observationDrift,
  reconcileProjectedDifferences,
} from './fix-uw-history-drift.ts'
import { withRoxabiGitHubPolicy } from './github-policy.ts'
import { loadReviewClassCatalogues } from './review-class-catalogues.ts'
import type { UwRead } from './uw-contract.ts'
import { createInstalledUwReadPort } from './uw-read-port.ts'

export type FixUwCausalContext = WorkflowCausalContext

function mergeObservedHistory(
  history: DecodedHistory,
  cohort: string,
  histories: Map<string, HistoryEntry>,
  different: HistoryDifference[],
): CausalResult<true> {
  const scope = history.source.scope
  const key = `${scope.repository}\0${scope.target}`
  const previous = histories.get(key)
  if (
    !history.source.complete ||
    (previous !== undefined && JSON.stringify(previous.history.source) !== JSON.stringify(history.source))
  )
    return observationDrift(history, cohort, previous)
  if (previous === undefined) histories.set(key, { history, cohort })
  else if (JSON.stringify(previous.history) !== JSON.stringify(history)) different.push({ history, cohort, previous })
  return { ok: true, value: true }
}

/** Combine observations only when every shared scope denotes the same complete history. */
export function mergeFixUwHistories(
  observed: readonly DecodedHistory[],
  current: readonly DecodedHistory[],
): CausalResult<readonly DecodedHistory[]> {
  const histories = new Map<string, HistoryEntry>()
  const different: HistoryDifference[] = []
  for (const cohort of [
    { name: 'observed', histories: observed },
    { name: 'current', histories: current },
  ]) {
    for (const history of cohort.histories) {
      const merged = mergeObservedHistory(history, cohort.name, histories, different)
      if (!merged.ok) return merged
    }
  }
  if (different.length > 0) {
    const reconciled = reconcileProjectedDifferences(histories, different)
    if (!reconciled.ok) return reconciled
  }
  return { ok: true, value: [...histories.values()].map((entry) => entry.history) }
}

/** The refusal codes are unchanged; the observation's own reasons ride along when it has any. */
function unsettled(codes: readonly string[], reasons: readonly string[]): CausalResult<never> {
  const diagnostics = ['fix-own-uw-unsettled', ...codes]
  return reasons.length === 0 ? { ok: false, diagnostics } : { ok: false, diagnostics, reasons }
}

/** Reuse only the completed closure and catalogue table of this exact UW observation. */
export async function composeObservedUwCausalContext(
  read: UwRead,
  selected: readonly DecodedHistory[],
  options: GitHubOptions,
): Promise<CausalResult<WorkflowCausalContext>> {
  if (
    read.causalObservation?.status !== 'complete' ||
    read.causalObservation.histories !== read.histories ||
    read.causalObservation.catalogues !== read.catalogues
  )
    return unsettled(['fix-causal-observation-unavailable'], observationReasons(read.observation))
  if (
    read.observation.status !== 'complete' ||
    read.observation.histories !== read.histories ||
    read.observation.catalogues !== read.catalogues
  )
    return unsettled(['fix-completion-observation-unavailable'], observationReasons(read.observation))
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
      return causalFailure('fix-own-uw-unsettled', 'fix-history-observation-drift')
    scopes.add(key)
    if (scope.repository === read.uw.repository && scope.target === read.uw.target) own = true
  }
  if (!own) return causalFailure('fix-own-uw-unsettled', 'fix-causal-own-history-missing')
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
): Promise<CausalResult<FixUwCausalContext>> {
  try {
    const read = await createInstalledUwReadPort({
      cwd: options.cwd,
      gh: options.gh ?? defaultGh(),
      ...(options.readAuthor === undefined ? {} : { readAuthor: options.readAuthor }),
    }).readUw(scope)
    return composeObservedUwCausalContext(read, selected, options)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return unsettled(['fix-completion-observation-unavailable'], [reasonLine(`uw-read-failed: ${detail}`)])
  }
}

async function collectJointUwCausalContext(
  root: Scope,
  histories: readonly DecodedHistory[],
  options: GitHubOptions,
): Promise<CausalResult<WorkflowCausalContext>> {
  const policy = withRoxabiGitHubPolicy(options)
  const observation = await readUwCompletionObservation(
    root,
    policy,
    (observed) => loadReviewClassCatalogues({ histories: observed, cwd: options.cwd, gh: options.gh ?? defaultGh() }),
    [],
    histories,
  )
  if (observation.status !== 'complete')
    return unsettled(
      observation.diagnostics.map((item) => item.code),
      observationReasons(observation),
    )
  return { ok: true, value: { histories: observation.histories, catalogues: observation.catalogues, observation } }
}
