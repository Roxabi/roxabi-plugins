import type { ActionInputs } from '../engine/action-input-schema.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { Result } from '../engine/result.ts'
import type { VerifiedExpansionRoot } from './uw-action-closure.ts'
import type { UwActionRequest } from './uw-action-contract.ts'
import { type PlannerExpansion, plannerExpansion } from './uw-action-negative-expansion.ts'
import { actionFailure } from './uw-action-result.ts'
import { type NegativeContributionOrigin, resolveNegativeContribution } from './uw-context-negative-contribution.ts'
import { type NonPlanExpansion, nonPlanExpansion } from './uw-context-negative-workflow.ts'

export type ExpansionOrigin = {
  previous?: ActionInputs
  planner?: PlannerExpansion
  workflow?: NonPlanExpansion
  root?: VerifiedExpansionRoot
}

function contributionOrigin(contribution: NegativeContributionOrigin): ExpansionOrigin {
  if (contribution.inherited === true) return { root: { rootAttemptId: contribution.currentRootAttemptId } }
  return {
    previous: contribution.previous,
    root: { rootAttemptId: contribution.rootAttemptId, negativeRef: contribution.negativeRef },
  }
}

/** Resolve a single explicitly cited negative; replay never uses this fresh-preparation path. */
export function expansionOrigin(
  request: UwActionRequest,
  histories: readonly DecodedHistory[],
  reviewedFingerprint?: string,
): Result<ExpansionOrigin | null> {
  if (reviewedFingerprint !== undefined) return { ok: true, value: null }
  const planner = plannerExpansion(request, histories)
  if (!planner.ok) return planner
  const workflow = nonPlanExpansion(request, histories)
  if (!workflow.ok) return workflow
  const contribution = resolveNegativeContribution(request, histories)
  if (!contribution.ok) return contribution
  const inheritedRoot =
    contribution.value?.inherited === true ? { rootAttemptId: contribution.value.currentRootAttemptId } : undefined
  const freshContribution = contribution.value !== null && contribution.value.inherited !== true
  const count = Number(planner.value !== null) + Number(workflow.value !== null) + Number(freshContribution)
  if (count > 1) return actionFailure('action-input-cycle', 'Expansion names competing negative origins')
  if (planner.value !== null)
    return {
      ok: true,
      value: {
        previous: planner.value.previous,
        planner: planner.value,
        ...(inheritedRoot === undefined ? {} : { root: inheritedRoot }),
      },
    }
  if (workflow.value !== null)
    return {
      ok: true,
      value: {
        previous: workflow.value.previous,
        workflow: workflow.value,
        ...(inheritedRoot === undefined ? {} : { root: inheritedRoot }),
      },
    }
  if (contribution.value !== null) return { ok: true, value: contributionOrigin(contribution.value) }
  return { ok: true, value: null }
}
