import { describe, expect, it } from 'vitest'
import { actionCompletion } from '../../engine/workflow-action-completion.ts'
import { planMacro } from '../../engine/workflow-plan-macro.ts'
import { reconstructWorkflow } from '../../engine/workflow-reconstruction-admission.ts'
import { roxabiWorkflowFixtures } from '../roxabi-presets.ts'
import {
  BODY,
  decisions,
  eligiblePlan,
  HEAD,
  PR,
  SCOPE,
  shippedFacts,
  shippedMandate,
} from './support/workflow-decision-fixtures.ts'

const {
  blockingPlanContribution,
  clearPlanContribution,
  featureMandate,
  historyFrom,
  implementStart,
  planAmendmentRecords,
  planDraftRecords,
  planReviewRecord,
  planReviewStart,
  publishedPlanDigest,
  rejectedImplementResult,
  workflowBinding,
} = roxabiWorkflowFixtures()

describe('workflow completion decisions', () => {
  it('does not treat a bound draft as complete before its review', () => {
    const mandate = featureMandate(SCOPE, { body: BODY })
    if (mandate.kind !== 'mandate') throw new Error('expected a mandate')
    const evidence = { issue: historyFrom([mandate, ...planDraftRecords(mandate)]), pullRequest: null, parents: [] }
    const macro = planMacro(evidence, mandate)
    expect(macro.phase).toBe('needs-review')
    expect(macro.phase).not.toBe('eligible')
    expect(actionCompletion('plan', evidence, decisions(), mandate).status).toBe('not-started')
  })

  it('sends a blocking review back to the plan instead of confirming it', () => {
    const mandate = featureMandate(SCOPE, { body: BODY })
    if (mandate.kind !== 'mandate') throw new Error('expected a mandate')
    const draft = planDraftRecords(mandate)
    const review = planReviewRecord(mandate, 'act-plan-1', publishedPlanDigest(), [
      blockingPlanContribution('slot-architect', 'R-workflow-plan-architect', 'plan-block-1'),
      clearPlanContribution('slot-adversarial', 'R-workflow-plan-adversarial'),
    ])
    const evidence = {
      issue: historyFrom([mandate, ...draft, planReviewStart(mandate, 'act-plan-1', publishedPlanDigest()), review]),
      pullRequest: null,
      parents: [],
    }
    const macro = planMacro(evidence, mandate)
    expect(macro.phase).toBe('needs-amendment')
    expect(macro.blockers).toEqual([
      { sourceId: 'slot-architect', slotId: 'slot-architect', blockerId: 'plan-block-1' },
    ])
    expect(actionCompletion('plan', evidence, decisions(), mandate).status).not.toBe('confirmed')
  })

  it('confirms a clear review of the bound plan and does not open another review', () => {
    const mandate = featureMandate(SCOPE, { body: BODY })
    if (mandate.kind !== 'mandate') throw new Error('expected a mandate')
    const draft = planDraftRecords(mandate)
    const review = planReviewRecord(mandate, 'act-plan-1', publishedPlanDigest(), [
      clearPlanContribution('slot-architect', 'R-workflow-plan-architect'),
      clearPlanContribution('slot-adversarial', 'R-workflow-plan-adversarial'),
    ])
    const evidence = {
      issue: historyFrom([mandate, ...draft, planReviewStart(mandate, 'act-plan-1', publishedPlanDigest()), review]),
      pullRequest: null,
      parents: [],
    }
    const macro = planMacro(evidence, mandate)
    expect(macro.phase).toBe('eligible')
    expect(macro.amendmentActionId).toBeNull()
    expect(actionCompletion('plan', evidence, decisions(), mandate).status).toBe('confirmed')
  })

  it('stays blocked when an amendment misses a declared blocker', () => {
    const mandate = featureMandate(SCOPE, { body: BODY })
    if (mandate.kind !== 'mandate') throw new Error('expected a mandate')
    const draft = planDraftRecords(mandate)
    const review = planReviewRecord(mandate, 'act-plan-1', publishedPlanDigest(), [
      blockingPlanContribution('slot-architect', 'R-workflow-plan-architect', 'plan-block-1'),
      clearPlanContribution('slot-adversarial', 'R-workflow-plan-adversarial'),
    ])
    const missed = planAmendmentRecords(mandate, 'act-plan-review-1', [], [])
    const macro = planMacro(
      {
        issue: historyFrom([
          mandate,
          ...draft,
          planReviewStart(mandate, 'act-plan-1', publishedPlanDigest()),
          review,
          ...missed,
        ]),
        pullRequest: null,
        parents: [],
      },
      mandate,
    )
    expect(macro.phase).toBe('blocked')
    expect(macro.phase).not.toBe('eligible')
    expect(macro.blockers).toEqual([
      { sourceId: 'slot-architect', slotId: 'slot-architect', blockerId: 'plan-block-1' },
    ])
  })

  it('confirms the plan only after the amendment covers every declared blocker', () => {
    const mandate = featureMandate(SCOPE, { body: BODY })
    if (mandate.kind !== 'mandate') throw new Error('expected a mandate')
    const blocker = { sourceId: 'slot-architect', slotId: 'slot-architect', blockerId: 'plan-block-1' }
    const draft = planDraftRecords(mandate)
    const review = planReviewRecord(mandate, 'act-plan-1', publishedPlanDigest(), [
      blockingPlanContribution('slot-architect', 'R-workflow-plan-architect', 'plan-block-1'),
      clearPlanContribution('slot-adversarial', 'R-workflow-plan-adversarial'),
    ])
    const covered = planAmendmentRecords(
      mandate,
      'act-plan-review-1',
      [blocker],
      [{ blocker, stepIds: ['step-1'], reason: 'the stale-region path is now mapped' }],
    )
    const evidence = {
      issue: historyFrom([
        mandate,
        ...draft,
        planReviewStart(mandate, 'act-plan-1', publishedPlanDigest()),
        review,
        ...covered,
      ]),
      pullRequest: null,
      parents: [],
    }
    const macro = planMacro(evidence, mandate)
    expect(macro.phase).toBe('eligible')
    expect(macro.amendmentActionId).toBe('act-plan-2')
    expect(actionCompletion('plan', evidence, decisions(), mandate).status).toBe('confirmed')
  })

  it('does not treat a clear review of another plan as completion', () => {
    const mandate = featureMandate(SCOPE, { body: BODY })
    if (mandate.kind !== 'mandate') throw new Error('expected a mandate')
    const draft = planDraftRecords(mandate)
    const review = planReviewRecord(mandate, 'act-plan-1', 'ab'.repeat(32), [
      clearPlanContribution('slot-architect', 'R-workflow-plan-architect'),
      clearPlanContribution('slot-adversarial', 'R-workflow-plan-adversarial'),
    ])
    const macro = planMacro(
      {
        issue: historyFrom([mandate, ...draft, planReviewStart(mandate, 'act-plan-1', 'ab'.repeat(32)), review]),
        pullRequest: null,
        parents: [],
      },
      mandate,
    )
    expect(macro.phase).not.toBe('eligible')
    expect(macro.phase).toBe('needs-review')
  })

  it('blocks an invalid specialist slot instead of starting another review batch', () => {
    const mandate = shippedMandate()
    if (mandate.kind !== 'mandate') throw new Error('expected a mandate')
    const draft = planDraftRecords(mandate)
    const review = planReviewRecord(mandate, 'act-plan-1', publishedPlanDigest(), [
      clearPlanContribution('slot-architect', 'R-workflow-plan-architect'),
      clearPlanContribution('slot-adversarial', 'R-workflow-plan-adversarial'),
    ])
    if (
      review.kind !== 'action-receipt' ||
      review.payload.action !== 'plan-review' ||
      review.payload.phase !== 'result'
    ) {
      throw new Error('expected a plan-review result')
    }
    review.payload.contributions[1] = {
      ...review.payload.contributions[1],
      structured: { outcome: 'not-a-review' },
    }
    const evidence = {
      issue: historyFrom([mandate, ...draft, planReviewStart(mandate, 'act-plan-1', publishedPlanDigest()), review]),
      pullRequest: null,
      parents: [],
    }
    const macro = planMacro(evidence, mandate)
    expect(macro.phase).toBe('blocked')
    const decision = reconstructWorkflow({ evidence, facts: shippedFacts(), decisions: decisions() })
    expect(decision).toMatchObject({ status: 'blocked', reason: 'missing-contribution' })
    expect(decision).not.toMatchObject({ status: 'action' })
  })

  it('does not dispatch another plan review when the review start has no result', () => {
    const mandate = shippedMandate()
    if (mandate.kind !== 'mandate') throw new Error('expected a mandate')
    const evidence = {
      issue: historyFrom([
        mandate,
        ...planDraftRecords(mandate),
        planReviewStart(mandate, 'act-plan-1', publishedPlanDigest()),
      ]),
      pullRequest: null,
      parents: [],
    }
    expect(planMacro(evidence, mandate).phase).toBe('uncertain')
    const decision = reconstructWorkflow({ evidence, facts: shippedFacts(), decisions: decisions() })
    expect(decision).toMatchObject({ status: 'blocked', reason: 'action-uncertain' })
    expect(decision).not.toMatchObject({ status: 'action' })
  })

  it('does not replay an implement start or a rejected implement result', () => {
    const mandate = shippedMandate()
    if (mandate.kind !== 'mandate') throw new Error('expected a mandate')
    const started = {
      issue: historyFrom([...eligiblePlan(mandate), implementStart(mandate)]),
      pullRequest: null,
      parents: [],
    }
    const startedDecision = reconstructWorkflow({ evidence: started, facts: shippedFacts(), decisions: decisions() })
    expect(startedDecision).toMatchObject({ status: 'blocked', reason: 'action-uncertain' })
    expect(startedDecision).not.toMatchObject({ status: 'action' })
    const rejected = {
      issue: historyFrom([...eligiblePlan(mandate), implementStart(mandate), rejectedImplementResult(mandate)]),
      pullRequest: null,
      parents: [],
    }
    const rejectedDecision = reconstructWorkflow({ evidence: rejected, facts: shippedFacts(), decisions: decisions() })
    expect(rejectedDecision).toMatchObject({ status: 'blocked', reason: 'unconfirmed' })
    expect(rejectedDecision).not.toMatchObject({ status: 'action' })
    const pull = { scope: PR, head: HEAD, base: 'main', associatedIssue: SCOPE }
    const rejectedBound = {
      issue: rejected.issue,
      pullRequest: historyFrom([workflowBinding(PR, mandate, 'feat/42-save', 'main')], 'operator', 'operator', [
        rejected.issue,
      ]),
      parents: [],
    }
    const rejectedBoundDecision = reconstructWorkflow({
      evidence: rejectedBound,
      facts: shippedFacts(pull),
      decisions: decisions(),
    })
    expect(rejectedBoundDecision).toMatchObject({ status: 'blocked', reason: 'unconfirmed' })
    expect(actionCompletion('implement', rejected, decisions(), mandate).status).not.toBe('confirmed')
  })
})
