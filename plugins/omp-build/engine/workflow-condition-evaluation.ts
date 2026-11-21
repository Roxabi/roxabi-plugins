import { canonicalValueDigest } from './action-input.ts'
import type { DecodedHistory } from './history-schema.ts'
import { resolveSpecEffective } from './spec-effective.ts'
import { resolveAcceptedSpec } from './workflow-accepted-spec.ts'
import { boundCiAttribution } from './workflow-action-completion.ts'
import type { ProposedAssessmentState } from './workflow-action-operands.ts'
import { adoptedOrConfirmed, implementConfirmed, planConfirmed, workflowBound } from './workflow-action-state.ts'
import { type MandateRecord, recordsOf } from './workflow-control.ts'
import type { WorkflowCondition } from './workflow-graph.ts'
import type { AcceptedChildCommitment } from './workflow-mandate-schema.ts'
import type { WorkflowCausalContext } from './workflow-plan.ts'
import type { SpecializedDecisions, WorkflowFacts } from './workflow-reconstruction-types.ts'

export function conditionHolds(
  when: WorkflowCondition,
  history: DecodedHistory,
  facts: WorkflowFacts,
  decisions: SpecializedDecisions,
  mandate: MandateRecord | null,
  pullRequest: DecodedHistory | null,
  causal: WorkflowCausalContext,
): boolean | null {
  switch (when) {
    case 'always':
      return true
    case 'no-mandate':
      return mandate === null
    case 'mandate-ready':
      return mandate !== null
    case 'spec-differs':
      return specMatches(false, facts, mandate, causal)
    case 'spec-settled':
      return specMatches(true, facts, mandate, causal)
    case 'plan-confirmed':
      return planConfirmed(history, mandate, causal)
    case 'implement-confirmed':
      return implementConfirmed(history, mandate, causal)
    case 'pr-open':
      return pullRequestIsOpen(history, facts, mandate, pullRequest, causal)
    case 'review-step-review':
      return decisions.reviewStep === 'review'
    case 'review-step-fix':
      return decisions.reviewStep === 'fix'
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
  facts: WorkflowFacts,
  mandate: MandateRecord | null,
  causal: WorkflowCausalContext,
): boolean {
  if (mandate === null || facts.currentSpec === null) return false
  const accepted = resolveAcceptedSpec(mandate, causal.histories)
  if (!accepted.ok) return false
  const effective = settled
    ? resolveSpecEffective({
        mode: 'current',
        own: accepted.spec.ref,
        histories: causal.histories,
        graph: causal.observation.graph,
      })
    : resolveSpecEffective({
        mode: 'historical',
        own: accepted.spec.ref,
        versionVector: [accepted.spec.ref, ...accepted.spec.inheritedOwnSpecRefs],
        histories: causal.histories,
      })
  if (!effective.ok) return false
  const same =
    facts.currentSpec.snapshot.spec.version === accepted.spec.snapshot.spec.version &&
    facts.currentSpec.tier === accepted.spec.tier &&
    sameChildren(facts.currentSpec.children, accepted.spec.children) &&
    canonicalValueDigest(facts.currentSpec.inheritedOwnSpecRefs) ===
      canonicalValueDigest(accepted.spec.inheritedOwnSpecRefs) &&
    canonicalValueDigest(facts.currentSpec.coverage) === canonicalValueDigest(accepted.spec.coverage)
  return settled ? same : !same
}

function sameChildren(
  current: readonly ProposedAssessmentState['children'][number][],
  accepted: readonly AcceptedChildCommitment[],
): boolean {
  if (current.length !== accepted.length) return false
  for (let index = 0; index < current.length; index += 1) {
    const left = current[index]
    const right = accepted[index]
    if (
      left === undefined ||
      'kind' in left ||
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
  causal: WorkflowCausalContext,
): boolean {
  return (
    facts.pullRequest !== null &&
    workflowBound(mandate, history, pullRequest, facts) &&
    adoptedOrConfirmed(history, mandate, causal)
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
  if (decisions.ciWatchStatus !== 'red' || decisions.reviewStep !== 'fix-ci') return false
  const bound = boundCiAttribution([history, ...(pullRequest === null ? [] : [pullRequest])], facts, mandate)
  if (when === 'ci-red') return !bound.change && !bound.refused
  return when === 'ci-attributed-change' ? bound.change : bound.refused
}
