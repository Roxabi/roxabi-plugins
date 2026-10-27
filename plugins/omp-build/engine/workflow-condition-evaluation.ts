import type { DecodedHistory } from './history-schema.ts'
import { resolveAcceptedSpec } from './workflow-accepted-spec.ts'
import { boundCiAttribution } from './workflow-action-completion.ts'
import { adoptedOrConfirmed, implementConfirmed, planConfirmed, workflowBound } from './workflow-action-state.ts'
import { type MandateRecord, recordsOf } from './workflow-control.ts'
import type { WorkflowCondition } from './workflow-graph.ts'
import type { AcceptedChildCommitment } from './workflow-mandate-schema.ts'
import type { SpecializedDecisions, WorkflowFacts } from './workflow-reconstruction-types.ts'

export function conditionHolds(
  when: WorkflowCondition,
  history: DecodedHistory,
  facts: WorkflowFacts,
  decisions: SpecializedDecisions,
  mandate: MandateRecord | null,
  pullRequest: DecodedHistory | null,
  externalHistories: readonly DecodedHistory[] = [],
): boolean | null {
  switch (when) {
    case 'always':
      return true
    case 'no-mandate':
      return mandate === null
    case 'mandate-ready':
      return mandate !== null
    case 'spec-differs':
      return specMatches(false, history, facts, mandate, externalHistories)
    case 'spec-settled':
      return specMatches(true, history, facts, mandate, externalHistories)
    case 'plan-confirmed':
      return planConfirmed(history, mandate)
    case 'implement-confirmed':
      return implementConfirmed(history, mandate)
    case 'pr-open':
      return pullRequestIsOpen(history, facts, mandate, pullRequest)
    case 'review-step-review':
      return decisions.reviewStep === 'review'
    case 'review-step-fix':
      return decisions.reviewStep === 'fix' && decisions.ciWatchStatus !== 'red'
    case 'review-step-land':
      return decisions.reviewStep === 'land' && workflowBound(mandate, history, pullRequest, facts)
    case 'review-step-stop':
      return decisions.reviewStep === 'stop'
    case 'fix-confirmed':
      return recordsOf(history).some((record) => record.kind === 'fix-result')
    case 'ci-red':
    case 'ci-attributed-change':
    case 'ci-attribution-refused':
      return ciConditionHolds(when, history, facts, decisions, mandate, pullRequest)
    case 'merged':
      return facts.merged
    case 'end-obligations-met':
      return facts.endObligationsMet
    case 'epic-start':
      return decisions.epicStep === 'start'
    case 'epic-resume':
      return decisions.epicStep === 'resume'
    case 'epic-stop':
      return decisions.epicStep === 'stop'
    case 'epic-final-review':
      return decisions.epicStep === 'final-review'
    case 'epic-fix-ticket':
      return decisions.epicStep === 'fix-ticket'
    case 'epic-post-merge':
      return decisions.epicStep === 'post-merge'
    case 'epic-complete':
      return decisions.epicStep === 'complete'
    case 'epic-drop':
      return decisions.epicStep === 'drop'
    default:
      return null
  }
}

function specMatches(
  settled: boolean,
  history: DecodedHistory,
  facts: WorkflowFacts,
  mandate: MandateRecord | null,
  externalHistories: readonly DecodedHistory[],
): boolean {
  if (mandate === null || facts.currentSpec === null) return false
  const accepted = resolveAcceptedSpec(mandate, [history, ...externalHistories])
  if (!accepted.ok) return false
  const same =
    facts.currentSpec.snapshot.spec.version === accepted.spec.snapshot.spec.version &&
    facts.currentSpec.tier === accepted.spec.tier &&
    sameChildren(facts.currentSpec.children, accepted.spec.children)
  return settled ? same : !same
}

function sameChildren(
  current: readonly AcceptedChildCommitment[],
  accepted: readonly AcceptedChildCommitment[],
): boolean {
  if (current.length !== accepted.length) return false
  for (let index = 0; index < current.length; index += 1) {
    const left = current[index]
    const right = accepted[index]
    if (
      left === undefined ||
      right === undefined ||
      left.scope.repository !== right.scope.repository ||
      left.scope.target !== right.scope.target ||
      left.specVersion !== right.specVersion ||
      left.tier !== right.tier
    )
      return false
  }
  return true
}

function pullRequestIsOpen(
  history: DecodedHistory,
  facts: WorkflowFacts,
  mandate: MandateRecord | null,
  pullRequest: DecodedHistory | null,
): boolean {
  return (
    facts.pullRequest !== null &&
    workflowBound(mandate, history, pullRequest, facts) &&
    adoptedOrConfirmed(history, mandate)
  )
}

function ciConditionHolds(
  when: 'ci-red' | 'ci-attributed-change' | 'ci-attribution-refused',
  history: DecodedHistory,
  facts: WorkflowFacts,
  decisions: SpecializedDecisions,
  mandate: MandateRecord | null,
  pullRequest: DecodedHistory | null,
): boolean {
  if (decisions.ciWatchStatus !== 'red' || decisions.reviewStep !== 'fix') return false
  const bound = boundCiAttribution([history, ...(pullRequest === null ? [] : [pullRequest])], facts, mandate)
  if (when === 'ci-red') return !bound.change && !bound.refused
  return when === 'ci-attributed-change' ? bound.change : bound.refused
}
