import {
  canonicalValueDigest,
  historyFor,
  type MandateRecord,
  mandateScope,
  outstandingPauseRequest,
  planMacro,
  unliftedPause,
} from '../dist/contracts.js'
import type { Result } from '../engine/result.ts'
import type { PlanMacro, WorkflowEvidence } from '../engine/workflow-plan.ts'
import type { PlannerExpansion } from './uw-action-negative-expansion.ts'
import { matchesReviewedDraft } from './uw-action-planner-lineage.ts'
import { actionFailure } from './uw-action-result.ts'

export function expandedPlannerMacro(
  evidence: WorkflowEvidence,
  mandate: MandateRecord,
  expansion: PlannerExpansion,
  excludedStarts?: ReadonlySet<string>,
): Result<PlanMacro> {
  if (outstandingPauseRequest(evidence.issue, mandate) !== null || unliftedPause(evidence.issue, mandate) !== null)
    return actionFailure('action-input-missing', 'Planner authority has an outstanding or active pause')
  const blocked = planMacro(evidence, mandate, { excludedStarts })
  if (
    blocked.phase !== 'blocked' ||
    blocked.evidence.length === 0 ||
    blocked.evidence.some((item) => item.code !== 'action-context-missing')
  )
    return actionFailure('action-input-missing', 'The selected negative is not the only planner block')
  const issue = historyFor(mandateScope(mandate), expansion.histories)
  if (issue === null) return actionFailure('record-unreadable', 'Expanded planner history is absent')
  const macro = planMacro({ ...evidence, issue }, mandate, { contextLeaf: expansion.leaf, excludedStarts })
  const { slot } = expansion
  const exact = slot.exact
  if (exact.mandateId !== mandate.recordId || exact.specDigest !== macro.specDigest)
    return actionFailure('review-input-changed', 'Expanded planner request changes mandate or Spec')
  if (slot.action === 'plan') {
    if (
      slot.exact.amendsReviewActionId === null
        ? macro.phase !== 'needs-draft'
        : macro.phase !== 'needs-amendment' ||
          macro.reviewActionId !== slot.exact.amendsReviewActionId ||
          canonicalValueDigest(macro.blockers) !== canonicalValueDigest(slot.exact.requiredBlockers)
    )
      return actionFailure('review-input-changed', 'Expanded planner request changes its semantic slot')
  } else if (!matchesReviewedDraft(issue, macro, slot)) {
    return actionFailure('review-input-changed', 'Expanded plan review changes its reviewed draft')
  }
  return { ok: true, value: macro }
}
