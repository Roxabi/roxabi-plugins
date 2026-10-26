import type { DecodedHistory } from './history-schema.ts'
import { resolveAcceptedSpec } from './workflow-accepted-spec.ts'
import { boundCiAttribution } from './workflow-action-completion.ts'
import { adoptedOrConfirmed, implementConfirmed, planConfirmed, workflowBound } from './workflow-action-state.ts'
import { type MandateRecord, recordsOf } from './workflow-control.ts'
import type { WorkflowCondition } from './workflow-graph.ts'
import type { SpecializedDecisions, WorkflowFacts } from './workflow-reconstruction-types.ts'

export function conditionHolds(
  when: WorkflowCondition,
  history: DecodedHistory,
  facts: WorkflowFacts,
  decisions: SpecializedDecisions,
  mandate: MandateRecord | null,
  pullRequest: DecodedHistory | null,
): boolean | null {
  switch (when) {
    case 'always':
      return true
    case 'no-mandate':
      return mandate === null
    case 'mandate-ready':
      return mandate !== null
    case 'spec-differs':
      return specMatches(false, history, facts, mandate)
    case 'spec-settled':
      return specMatches(true, history, facts, mandate)
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
): boolean {
  if (mandate === null || facts.specDigest === null) return false
  const accepted = resolveAcceptedSpec(mandate, [history])
  if (!accepted.ok) return false
  return settled ? facts.specDigest === accepted.spec.digest : facts.specDigest !== accepted.spec.digest
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
