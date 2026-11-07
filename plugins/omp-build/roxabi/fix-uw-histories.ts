import { type GitHubOptions, readUwCompletionObservation } from '../dist/contracts.js'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import type { WorkflowCausalContext } from '../engine/workflow-plan.ts'
import type { WithdrawalBarrier } from '../skills/feature/workflow-gate.js'
import { defaultGh } from './feature-engine.ts'
import type { FixActionResult } from './fix-contract.ts'
import { failure } from './fix-contract.ts'
import { withRoxabiGitHubPolicy } from './github-policy.ts'
import { loadReviewClassCatalogues } from './review-class-catalogues.ts'
import type { UwRead } from './uw-contract.ts'
import { createInstalledUwReadPort } from './uw-read-port.ts'

export type FixUwCausalContext = WorkflowCausalContext

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
  if (
    read.observation.status !== 'complete' ||
    read.observation.histories !== read.histories ||
    read.observation.catalogues !== read.catalogues
  )
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
