import { canonicalValueDigest } from '../engine/action-input.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { Result } from '../engine/result.ts'
import { workflowContextDirectSuccessor } from '../engine/workflow-context-terminal.ts'
import { historyFor, type ReceiptRecord, recordsOf } from '../engine/workflow-control.ts'
import { planDigest, planOutputSchema } from '../engine/workflow-output-schema.ts'
import type { PlanMacro } from '../engine/workflow-plan.ts'
import type { PlannerExpansion } from './uw-action-negative-expansion.ts'
import { actionFailure } from './uw-action-result.ts'

export function matchesReviewedDraft(
  issue: DecodedHistory,
  macro: PlanMacro,
  slot: Extract<PlannerExpansion['slot'], { action: 'plan-review' }>,
): boolean {
  const plans = recordsOf(issue).filter(
    (record) =>
      record.kind === 'action-receipt' &&
      record.payload.action === 'plan' &&
      record.payload.phase === 'result' &&
      record.payload.actionId === slot.exact.draftActionId,
  )
  const result = plans[0]
  const plan =
    result?.kind === 'action-receipt' && result.payload.phase === 'result'
      ? planOutputSchema.safeParse(result.payload.structured)
      : null
  return (
    macro.phase === 'needs-review' &&
    macro.draftActionId === slot.exact.draftActionId &&
    plans.length === 1 &&
    plan?.success === true &&
    planDigest(plan.data) === slot.exact.planDigest
  )
}

function checkConnected(
  candidates: readonly ReceiptRecord[],
  leaf: ReceiptRecord,
  next: ReadonlyMap<string, string>,
): Result<true> {
  for (const candidate of candidates) {
    const seen = new Set<string>()
    let current = candidate.recordId
    while (current !== leaf.recordId) {
      if (seen.has(current)) return actionFailure('action-input-cycle', 'Planner negative lineage is cyclic')
      seen.add(current)
      const successor = next.get(current)
      if (successor === undefined)
        return actionFailure('action-input-cycle', 'Planner negative lineage is disconnected')
      current = successor
    }
  }
  return { ok: true, value: true }
}

/** Select the sole unresolved leaf, retaining only authenticated cited ancestors for temporary evaluation. */
export function plannerLineage<T extends ReceiptRecord>(
  candidates: readonly T[],
  histories: readonly DecodedHistory[],
): Result<{ leaf: T; chain: readonly T[] }> {
  const next = new Map<string, string>()
  for (const candidate of candidates) {
    const history = historyFor({ repository: candidate.repository, target: candidate.target }, histories)
    if (history === null) return actionFailure('record-unreadable', 'Planner negative history is absent')
    const successor = workflowContextDirectSuccessor(history, candidate)
    if (successor.status === 'uncertain' || successor.status === 'ambiguous')
      return actionFailure('record-unreadable', 'Planner negative lineage is uncertain or forked')
    if (successor.status === 'successor') {
      const cited = candidates.find((item) => canonicalValueDigest(item) === canonicalValueDigest(successor.record))
      if (cited === undefined) return actionFailure('record-unreadable', 'Planner negative successor is not cited')
      next.set(candidate.recordId, cited.recordId)
    }
  }
  const leaves = candidates.filter((candidate) => !next.has(candidate.recordId))
  const leaf = leaves[0]
  if (leaves.length !== 1 || leaf === undefined)
    return actionFailure('action-input-cycle', 'Expansion names competing negative planner results')
  const connected = checkConnected(candidates, leaf, next)
  if (!connected.ok) return connected
  return { ok: true, value: { leaf, chain: candidates } }
}
