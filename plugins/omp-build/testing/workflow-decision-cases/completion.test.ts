import { describe, expect, it } from 'vitest'
import type { DecodedHistory } from '../../engine/history-schema.ts'
import { actionCompletion } from '../../engine/workflow-action-completion.ts'
import { planMacro } from '../../engine/workflow-plan-macro.ts'
import { reconstructWorkflow } from '../../engine/workflow-reconstruction-admission.ts'
import { observeFixtureNativeWorld } from '../action-input-fixtures.ts'
import { roxabiWorkflowFixtures } from '../roxabi-presets.ts'
import { nativeDecisionBody, nativeDecisionMandate } from './support/native-decision-spec.ts'
import {
  authenticatedPlanFixtures,
  BODY,
  decisions,
  eligiblePlan,
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
  publishedPlanDigest,
  rejectedImplementResult,
} = roxabiWorkflowFixtures()

type Actions = ReturnType<typeof roxabiWorkflowFixtures>
const planDraftRecords = (...args: Parameters<Actions['planDraftRecords']>) =>
  authenticatedPlanFixtures(args[0], [historyFrom([args[0]])]).workflow.planDraftRecords(...args)
const planReviewStart = (...args: Parameters<Actions['planReviewStart']>) =>
  authenticatedPlanFixtures(args[0], [historyFrom([args[0]])]).workflow.planReviewStart(...args)
const planReviewRecord = (...args: Parameters<Actions['planReviewRecord']>) =>
  authenticatedPlanFixtures(args[0], [historyFrom([args[0]])]).workflow.planReviewRecord(...args)
const planAmendmentRecords = (...args: Parameters<Actions['planAmendmentRecords']>) =>
  authenticatedPlanFixtures(args[0], [historyFrom([args[0]])]).workflow.planAmendmentRecords(...args)

async function rootEvidence(issue: DecodedHistory) {
  const causal = await observeFixtureNativeWorld({
    root: SCOPE,
    nodes: [
      {
        scope: SCOPE,
        title: 'Save the selected region',
        body: nativeDecisionBody,
        updatedAt: '2026-10-21T12:00:00Z',
        labels: ['size:S'],
        parent: null,
        children: [],
        blockers: [],
        state: 'OPEN',
        stateReason: null,
      },
    ],
    histories: [issue],
    pullRequests: [],
    commits: [],
    comparisons: [],
  })
  return { issue, pullRequest: null, parents: [], causal }
}

describe('workflow completion decisions', () => {
  it('does not treat a bound draft as complete before its review', async () => {
    const mandate = nativeDecisionMandate(featureMandate(SCOPE, { body: BODY }))
    if (mandate.kind !== 'mandate') throw new Error('expected a mandate')
    const evidence = await rootEvidence(historyFrom([mandate, ...planDraftRecords(mandate)]))
    const macro = planMacro(evidence, mandate)
    expect(macro.phase).toBe('needs-review')
    expect(macro.phase).not.toBe('eligible')
    expect(actionCompletion('plan', evidence, decisions(), mandate).status).toBe('not-started')
  })

  it('sends a blocking review back to the plan instead of confirming it', async () => {
    const mandate = nativeDecisionMandate(featureMandate(SCOPE, { body: BODY }))
    if (mandate.kind !== 'mandate') throw new Error('expected a mandate')
    const draft = planDraftRecords(mandate)
    const review = planReviewRecord(mandate, 'act-plan-1', publishedPlanDigest(), [
      blockingPlanContribution('slot-architect', 'R-workflow-plan-architect', 'plan-block-1'),
      clearPlanContribution('slot-adversarial', 'R-workflow-plan-adversarial'),
    ])
    const evidence = await rootEvidence(
      historyFrom([mandate, ...draft, planReviewStart(mandate, 'act-plan-1', publishedPlanDigest()), review]),
    )
    const macro = planMacro(evidence, mandate)
    expect(macro.phase).toBe('needs-amendment')
    expect(macro.blockers).toEqual([
      { sourceId: 'slot-architect', slotId: 'slot-architect', blockerId: 'plan-block-1' },
    ])
    expect(actionCompletion('plan', evidence, decisions(), mandate).status).not.toBe('confirmed')
  })

  it('confirms a clear review of the bound plan and does not open another review', async () => {
    const mandate = nativeDecisionMandate(featureMandate(SCOPE, { body: BODY }))
    if (mandate.kind !== 'mandate') throw new Error('expected a mandate')
    const draft = planDraftRecords(mandate)
    const review = planReviewRecord(mandate, 'act-plan-1', publishedPlanDigest(), [
      clearPlanContribution('slot-architect', 'R-workflow-plan-architect'),
      clearPlanContribution('slot-adversarial', 'R-workflow-plan-adversarial'),
    ])
    const evidence = await rootEvidence(
      historyFrom([mandate, ...draft, planReviewStart(mandate, 'act-plan-1', publishedPlanDigest()), review]),
    )
    const macro = planMacro(evidence, mandate)
    expect(macro.phase).toBe('eligible')
    expect(macro.amendmentActionId).toBeNull()
    expect(actionCompletion('plan', evidence, decisions(), mandate).status).toBe('confirmed')
  })

  it('stays blocked when an amendment misses a declared blocker', async () => {
    const mandate = nativeDecisionMandate(featureMandate(SCOPE, { body: BODY }))
    if (mandate.kind !== 'mandate') throw new Error('expected a mandate')
    const draft = planDraftRecords(mandate)
    const review = planReviewRecord(mandate, 'act-plan-1', publishedPlanDigest(), [
      blockingPlanContribution('slot-architect', 'R-workflow-plan-architect', 'plan-block-1'),
      clearPlanContribution('slot-adversarial', 'R-workflow-plan-adversarial'),
    ])
    const missed = planAmendmentRecords(mandate, 'act-plan-review-1', [], [])
    const macro = planMacro(
      await rootEvidence(
        historyFrom([
          mandate,
          ...draft,
          planReviewStart(mandate, 'act-plan-1', publishedPlanDigest()),
          review,
          ...missed,
        ]),
      ),
      mandate,
    )
    expect(macro.phase).toBe('blocked')
    expect(macro.phase).not.toBe('eligible')
    expect(macro.blockers).toEqual([
      { sourceId: 'slot-architect', slotId: 'slot-architect', blockerId: 'plan-block-1' },
    ])
  })

  it('confirms the plan only after the amendment covers every declared blocker', async () => {
    const mandate = nativeDecisionMandate(featureMandate(SCOPE, { body: BODY }))
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
    const evidence = await rootEvidence(
      historyFrom([
        mandate,
        ...draft,
        planReviewStart(mandate, 'act-plan-1', publishedPlanDigest()),
        review,
        ...covered,
      ]),
    )
    const macro = planMacro(evidence, mandate)
    expect(macro.phase).toBe('eligible')
    expect(macro.amendmentActionId).toBe('act-plan-2')
    expect(actionCompletion('plan', evidence, decisions(), mandate).status).toBe('confirmed')
  })

  it('does not treat a clear review of another plan as completion', async () => {
    const mandate = nativeDecisionMandate(featureMandate(SCOPE, { body: BODY }))
    if (mandate.kind !== 'mandate') throw new Error('expected a mandate')
    const draft = planDraftRecords(mandate)
    const review = planReviewRecord(mandate, 'act-plan-1', 'ab'.repeat(32), [
      clearPlanContribution('slot-architect', 'R-workflow-plan-architect'),
      clearPlanContribution('slot-adversarial', 'R-workflow-plan-adversarial'),
    ])
    const macro = planMacro(
      await rootEvidence(
        historyFrom([mandate, ...draft, planReviewStart(mandate, 'act-plan-1', 'ab'.repeat(32)), review]),
      ),
      mandate,
    )
    expect(macro.phase).not.toBe('eligible')
    expect(macro.phase).toBe('needs-review')
  })

  it('blocks an invalid specialist slot instead of starting another review batch', async () => {
    const mandate = nativeDecisionMandate(shippedMandate())
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
    const evidence = await rootEvidence(
      historyFrom([mandate, ...draft, planReviewStart(mandate, 'act-plan-1', publishedPlanDigest()), review]),
    )
    const macro = planMacro(evidence, mandate)
    expect(macro.phase).toBe('blocked')
    const decision = reconstructWorkflow({ evidence, facts: shippedFacts(mandate), decisions: decisions() })
    expect(decision).toMatchObject({ status: 'blocked', reason: 'missing-contribution' })
    expect(decision).not.toMatchObject({ status: 'action' })
  })

  it('does not dispatch another plan review when the review start has no result', async () => {
    const mandate = nativeDecisionMandate(shippedMandate())
    if (mandate.kind !== 'mandate') throw new Error('expected a mandate')
    const evidence = await rootEvidence(
      historyFrom([
        mandate,
        ...planDraftRecords(mandate),
        planReviewStart(mandate, 'act-plan-1', publishedPlanDigest()),
      ]),
    )
    expect(planMacro(evidence, mandate).phase).toBe('uncertain')
    const decision = reconstructWorkflow({ evidence, facts: shippedFacts(mandate), decisions: decisions() })
    expect(decision).toMatchObject({ status: 'blocked', reason: 'action-uncertain' })
    expect(decision).not.toMatchObject({ status: 'action' })
  })

  it('does not replay an implement start or a rejected implement result', async () => {
    const mandate = nativeDecisionMandate(shippedMandate())
    if (mandate.kind !== 'mandate') throw new Error('expected a mandate')
    const started = await rootEvidence(
      historyFrom([...eligiblePlan(mandate, [historyFrom([mandate])]), implementStart(mandate)]),
    )
    const startedDecision = reconstructWorkflow({
      evidence: started,
      facts: shippedFacts(mandate),
      decisions: decisions(),
    })
    expect(startedDecision).toMatchObject({ status: 'blocked', reason: 'action-uncertain' })
    expect(startedDecision).not.toMatchObject({ status: 'action' })
    const rejected = await rootEvidence(
      historyFrom([
        ...eligiblePlan(mandate, [historyFrom([mandate])]),
        implementStart(mandate),
        rejectedImplementResult(mandate),
      ]),
    )
    const rejectedDecision = reconstructWorkflow({
      evidence: rejected,
      facts: shippedFacts(mandate),
      decisions: decisions(),
    })
    expect(rejectedDecision).toMatchObject({ status: 'blocked', reason: 'unconfirmed' })
    expect(rejectedDecision).not.toMatchObject({ status: 'action' })
    expect(actionCompletion('implement', rejected, decisions(), mandate).status).not.toBe('confirmed')
  })
})
