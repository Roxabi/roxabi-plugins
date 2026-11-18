import {
  createHistoricalAcceptedSpecContext,
  type GitHubOptions,
  historicalAcceptedSpecOwnedHistories,
  readUwCompletionObservation,
} from '../dist/contracts.js'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import type { UwCompletionObservation } from '../engine/uw-completion-types.ts'
import type { HistoricalAcceptedSpecContext } from '../engine/workflow-context-succession-inspection.ts'
import type { WorkflowCausalContext } from '../engine/workflow-plan.ts'
import type { WithdrawalBarrier } from '../skills/feature/workflow-gate.js'
import { observationReasons, reasonLine } from './causal-refusal.ts'
import { defaultGh } from './feature-engine.ts'
import type { FixActionResult } from './fix-contract.ts'
import { failure } from './fix-contract.ts'
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

export type FixUwCausalContext = WorkflowCausalContext & {
  historical?: HistoricalAcceptedSpecContext
}

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
function mergeObservedHistory(
  history: DecodedHistory,
  cohort: string,
  histories: Map<string, HistoryEntry>,
  different: HistoryDifference[],
): FixActionResult<true> {
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
): FixActionResult<readonly DecodedHistory[]> {
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
function unsettled(codes: readonly string[], reasons: readonly string[]): FixActionResult<never> {
  const diagnostics = ['fix-own-uw-unsettled', ...codes]
  return reasons.length === 0 ? { ok: false, diagnostics } : { ok: false, diagnostics, reasons }
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
    return unsettled(['fix-causal-observation-unavailable'], observationReasons(read.observation))
  if (
    read.observation.status !== 'complete' ||
    read.observation.histories !== read.histories ||
    read.observation.catalogues !== read.catalogues
  )
    return unsettled(['fix-completion-observation-unavailable'], observationReasons(read.observation))
  const historyProblem = observedHistoryProblem(read, options)
  if (historyProblem !== null) return failure('fix-own-uw-unsettled', historyProblem)
  const merged = mergeFixUwHistories(read.histories, selected)
  if (!merged.ok) return merged
  if (merged.value.length === read.histories.length) {
    const historical =
      read.historical === undefined
        ? createHistoricalAcceptedSpecContext(read.histories)
        : { ok: true as const, value: read.historical }
    if (!historical.ok) return failure('fix-own-uw-unsettled', 'fix-causal-observation-unavailable')
    return boundCausalContext(read.observation, historical.value)
  }
  return collectJointUwCausalContext(read.uw, merged.value, options)
}

function observedHistoryProblem(read: UwRead, options: GitHubOptions): string | null {
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
      return 'fix-history-observation-drift'
    scopes.add(key)
    if (scope.repository === read.uw.repository && scope.target === read.uw.target) own = true
  }
  return own ? null : 'fix-causal-own-history-missing'
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
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return unsettled(['fix-completion-observation-unavailable'], [reasonLine(`uw-read-failed: ${detail}`)])
  }
}

export async function extendObservedUwCausalContext(
  previous: FixUwCausalContext,
  selected: readonly DecodedHistory[],
  options: GitHubOptions,
): Promise<FixActionResult<FixUwCausalContext>> {
  if (!coherentContext(previous)) return failure('fix-own-uw-unsettled', 'fix-causal-observation-unavailable')
  const merged = mergeFixUwHistories(previous.histories, selected)
  if (!merged.ok) return merged
  if (merged.value.length === previous.histories.length) return { ok: true, value: previous }
  return collectJointUwCausalContext(previous.observation.root, merged.value, options)
}

function coherentContext(context: WorkflowCausalContext): boolean {
  return (
    context.observation?.status === 'complete' &&
    context.histories === context.observation.histories &&
    context.catalogues === context.observation.catalogues
  )
}

/** A confirmed append explains history drift, never a change to retained native or delivery facts. */
export function reconcileWithdrawalContexts(
  before: WorkflowCausalContext,
  after: WorkflowCausalContext,
  scope: DecodedHistory['source']['scope'],
  barriers: readonly WithdrawalBarrier[],
): FixActionResult<WorkflowCausalContext> {
  if (!coherentContext(before) || !coherentContext(after))
    return failure('fix-own-uw-unsettled', 'fix-causal-observation-unavailable')
  const histories = reconcileWithdrawalHistories(before.histories, after.histories, scope, barriers)
  if (!histories.ok) return histories
  const { observedAt: _beforeTime, ...beforeGraph } = before.observation.graph
  const { observedAt: _afterTime, ...afterGraph } = after.observation.graph
  if (
    JSON.stringify(before.observation.root) !== JSON.stringify(after.observation.root) ||
    JSON.stringify(beforeGraph) !== JSON.stringify(afterGraph) ||
    JSON.stringify(before.observation.delivery) !== JSON.stringify(after.observation.delivery)
  )
    return failure('fix-own-uw-unsettled', 'fix-history-observation-drift')
  return { ok: true, value: after }
}

async function collectJointUwCausalContext(
  root: Scope,
  histories: readonly DecodedHistory[],
  options: GitHubOptions,
): Promise<FixActionResult<FixUwCausalContext>> {
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
  const historical = createHistoricalAcceptedSpecContext(observation.histories)
  if (!historical.ok) return failure('fix-own-uw-unsettled', 'fix-causal-observation-unavailable')
  return boundCausalContext(observation, historical.value)
}

function boundCausalContext(
  observation: Extract<UwCompletionObservation, { status: 'complete' }>,
  historical: HistoricalAcceptedSpecContext,
): FixActionResult<FixUwCausalContext> {
  const bound = historicalAcceptedSpecOwnedHistories(historical, observation.histories)
  if (!bound.ok) return failure('fix-own-uw-unsettled', 'fix-causal-observation-unavailable')
  return {
    ok: true,
    value: {
      histories: bound.value,
      catalogues: observation.catalogues,
      observation: bound.value === observation.histories ? observation : { ...observation, histories: bound.value },
      historical,
    },
  }
}
