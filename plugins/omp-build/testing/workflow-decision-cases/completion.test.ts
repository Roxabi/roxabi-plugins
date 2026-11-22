import { describe, expect, it } from 'vitest'
import {
  appendRecords,
  interruptedResult,
  pairOf,
  receiptOf,
  withPayload,
} from '../../engine/__tests__/workflow-interruption-support.ts'
import type { DecodedHistory } from '../../engine/history-schema.ts'
import { buildRecord } from '../../engine/record-construction.ts'
import { actionCompletion } from '../../engine/workflow-action-completion.ts'
import { abandoned, type MandateRecord } from '../../engine/workflow-control.ts'
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

/** Abandons `mandate` and selects a successor, as `/feature abandon` then `/feature new` publish them. */
function succession(mandate: MandateRecord) {
  const predecessor = { scope: SCOPE, recordId: mandate.recordId, kind: 'mandate' as const }
  const abandonedControl = buildRecord({
    version: 1,
    repository: mandate.repository,
    target: mandate.target,
    recordId: 'abandon-old-mandate',
    runId: mandate.runId,
    operationId: 'op-abandon-old-mandate',
    kind: 'operator-control',
    payload: {
      control: 'abandon',
      controlId: 'abandon-old-mandate',
      predecessor: null,
      mandate: predecessor,
    },
  })
  const successor = buildRecord({
    ...mandate,
    recordId: 'new-mandate',
    runId: 'run-next-mandate',
    operationId: 'op-new-mandate',
    payload: { ...mandate.payload, antecedent: predecessor },
  })
  if (!abandonedControl.ok || !successor.ok || successor.value.kind !== 'mandate')
    throw new Error('Expected a canonical abandonment and successor')
  const nextMandate = successor.value
  const nextRef = { scope: SCOPE, recordId: nextMandate.recordId, kind: 'mandate' as const }
  const selected = buildRecord({
    version: 1,
    repository: mandate.repository,
    target: mandate.target,
    recordId: 'select-next-mandate',
    runId: nextMandate.runId,
    operationId: 'op-select-next-mandate',
    kind: 'operator-control',
    payload: {
      control: 'select-successor',
      controlId: 'select-next-mandate',
      mandate: nextRef,
      predecessor,
      successor: nextRef,
    },
  })
  if (!selected.ok) throw new Error('Expected a canonical successor selection')
  return { nextMandate, records: [abandonedControl.value, nextMandate, selected.value] }
}

describe('workflow completion decisions', () => {
  it.each(['plan', 'plan-review'] as const)('holds a %s context negative only for its own mandate', async (action) => {
    const mandate = nativeDecisionMandate(featureMandate(SCOPE, { body: BODY }))
    const missing = {
      outcome: 'missing-context',
      missing: [
        { locator: { kind: 'information-request', description: 'Deployment region' }, reason: 'Required', targets: [] },
      ],
    }
    const draft = planDraftRecords(mandate)
    const digest = publishedPlanDigest()
    const reviewStart = planReviewStart(mandate, 'act-plan-1', digest)
    const slotAction = {
      actionId: 'act-plan-review-1-slot-architect',
      inputs: reviewStart.payload.inputs,
    }
    const slots = [
      { slotId: 'slot-architect', specialist: 'R-workflow-plan-architect' as const, action: slotAction },
      { slotId: 'slot-adversarial', specialist: 'R-workflow-plan-adversarial' as const },
    ]
    const negativeHost = clearPlanContribution('slot-architect', 'R-workflow-plan-architect')
    const review = withPayload(
      planReviewRecord(mandate, 'act-plan-1', digest, [
        {
          ...negativeHost,
          structured: missing,
          host: { ...negativeHost.host, action: slotAction },
        },
        clearPlanContribution('slot-adversarial', 'R-workflow-plan-adversarial'),
      ]),
      { slots },
    )
    const records =
      action === 'plan'
        ? [receiptOf(draft[0]), withPayload(receiptOf(draft[1]), { structured: missing })]
        : [...draft, withPayload(reviewStart, { slots }), review]
    const currentEvidence = await rootEvidence(historyFrom([mandate, ...records]))
    const current = planMacro(currentEvidence, mandate)
    expect(current.phase).toBe('blocked')
    expect(current.evidence.map((entry) => entry.code)).toContain('action-context-missing')
    const { nextMandate, records: succeeded } = succession(mandate)
    const issue = historyFrom([mandate, ...records, ...succeeded])
    expect(abandoned(issue, mandate)).toBe(true)
    const next = planMacro(await rootEvidence(issue), nextMandate)
    expect(next.phase).toBe('needs-draft')
    expect(next.evidence.map((entry) => entry.code)).not.toContain('action-context-missing')
  })

  it('keeps a cross-mandate plan negative uncertain when its pair is not authenticated', async () => {
    const mandate = nativeDecisionMandate(featureMandate(SCOPE, { body: BODY }))
    const missing = {
      outcome: 'missing-context',
      missing: [
        { locator: { kind: 'information-request', description: 'Deployment region' }, reason: 'Required', targets: [] },
      ],
    }
    const predecessor = { scope: SCOPE, recordId: mandate.recordId, kind: 'mandate' as const }
    const abandonedControl = buildRecord({
      version: 1,
      repository: mandate.repository,
      target: mandate.target,
      recordId: 'abandon-cross-mandate',
      runId: mandate.runId,
      operationId: 'op-abandon-cross-mandate',
      kind: 'operator-control',
      payload: {
        control: 'abandon',
        controlId: 'abandon-cross-mandate',
        predecessor: null,
        mandate: predecessor,
      },
    })
    const successor = buildRecord({
      ...mandate,
      recordId: 'cross-next-mandate',
      runId: 'run-cross-next-mandate',
      operationId: 'op-cross-next-mandate',
      payload: { ...mandate.payload, antecedent: predecessor },
    })
    if (!abandonedControl.ok || !successor.ok || successor.value.kind !== 'mandate')
      throw new Error('Expected a canonical abandonment and successor')
    const nextMandate = successor.value
    const nextRef = { scope: SCOPE, recordId: nextMandate.recordId, kind: 'mandate' as const }
    const selected = buildRecord({
      version: 1,
      repository: mandate.repository,
      target: mandate.target,
      recordId: 'select-cross-next-mandate',
      runId: nextMandate.runId,
      operationId: 'op-select-cross-next-mandate',
      kind: 'operator-control',
      payload: {
        control: 'select-successor',
        controlId: 'select-cross-next-mandate',
        mandate: nextRef,
        predecessor,
        successor: nextRef,
      },
    })
    if (!selected.ok) throw new Error('Expected a canonical successor selection')
    const lineage = [mandate, abandonedControl.value, nextMandate, selected.value]
    const prior = planDraftRecords(mandate)
    const currentStart = receiptOf(
      authenticatedPlanFixtures(nextMandate, [historyFrom(lineage)]).workflow.planDraftRecords(nextMandate)[0],
    )
    const mismatched = withPayload(receiptOf(prior[1]), {
      structured: missing,
      start: { scope: SCOPE, kind: 'action-receipt', recordId: currentStart.recordId },
    })
    const issue = historyFrom([...lineage, currentStart, mismatched])
    const next = planMacro(await rootEvidence(issue), nextMandate)
    expect(next.phase).toBe('uncertain')
    expect(next.evidence.map((entry) => entry.code)).toContain('action-uncertain')
    expect(next.phase).not.toBe('needs-draft')
  })

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

  it('plans a successor mandate whose predecessor implementation was rejected', async () => {
    const mandate = nativeDecisionMandate(shippedMandate())
    if (mandate.kind !== 'mandate') throw new Error('expected a mandate')
    const prior = [
      ...eligiblePlan(mandate, [historyFrom([mandate])]),
      implementStart(mandate),
      rejectedImplementResult(mandate),
    ]
    const { nextMandate, records } = succession(mandate)
    const evidence = await rootEvidence(historyFrom([...prior, ...records]))
    expect(actionCompletion('implement', evidence, decisions(), mandate).status).toBe('blocked')
    const decision = reconstructWorkflow({ evidence, facts: shippedFacts(nextMandate), decisions: decisions() })
    expect(decision).toMatchObject({ status: 'action', action: 'plan', mandateId: nextMandate.recordId })
  })

  it.each(['plan', 'plan-review'] as const)(
    'plans a successor mandate whose predecessor %s was interrupted',
    async (action) => {
      const mandate = nativeDecisionMandate(shippedMandate())
      if (mandate.kind !== 'mandate') throw new Error('expected a mandate')
      const { workflow, version } = authenticatedPlanFixtures(mandate, [historyFrom([mandate])])
      const [start, result] = pairOf(workflow.planDraftRecords(mandate, 'act-plan-1', version))
      const digest = workflow.publishedPlanDigest()
      const review = workflow.planReviewRecord(mandate, 'act-plan-1', digest, [], 'act-plan-review-1', version)
      const prior =
        action === 'plan'
          ? [start, interruptedResult(result)]
          : [
              start,
              result,
              workflow.planReviewStart(mandate, 'act-plan-1', digest, 'act-plan-review-1', version),
              interruptedResult(receiptOf(review), { contributions: [] }),
            ]
      const { nextMandate, records } = succession(mandate)
      const evidence = await rootEvidence(appendRecords(historyFrom([mandate]), [...prior, ...records]))
      expect(planMacro(evidence, mandate).phase).toBe('blocked')
      const decision = reconstructWorkflow({ evidence, facts: shippedFacts(nextMandate), decisions: decisions() })
      expect(decision).toMatchObject({ status: 'action', action: 'plan', mandateId: nextMandate.recordId })
    },
  )

  it.each([
    ['an orphan plan START', 'orphan'],
    ['a plan START whose RESULT does not authenticate it', 'resealed'],
  ] as const)('keeps a successor uncertain over a predecessor %s', async (_label, variant) => {
    const mandate = nativeDecisionMandate(shippedMandate())
    if (mandate.kind !== 'mandate') throw new Error('expected a mandate')
    const { workflow, version } = authenticatedPlanFixtures(mandate, [historyFrom([mandate])])
    const [start, result] = pairOf(workflow.planDraftRecords(mandate, 'act-plan-1', version))
    const exact = (result.payload as { exactInputs: { specDigest: string } }).exactInputs
    const specDigest = exact.specDigest.replace(/.$/, (last) => (last === '0' ? '1' : '0'))
    const prior =
      variant === 'orphan' ? [start] : [start, withPayload(result, { exactInputs: { ...exact, specDigest } })]
    const { nextMandate, records } = succession(mandate)
    const evidence = await rootEvidence(appendRecords(historyFrom([mandate]), [...prior, ...records]))
    const decision = reconstructWorkflow({ evidence, facts: shippedFacts(nextMandate), decisions: decisions() })
    expect(decision).toMatchObject({ status: 'blocked', reason: 'action-uncertain' })
  })

  it.each([
    ['paired with another mandate START', 'crossed'],
    ['whose sealed inputs differ from its START', 'resealed'],
  ] as const)('keeps a successor blocked by a predecessor rejection %s', async (_label, variant) => {
    const mandate = nativeDecisionMandate(shippedMandate())
    if (mandate.kind !== 'mandate') throw new Error('expected a mandate')
    const { nextMandate, records } = succession(mandate)
    const rejected = rejectedImplementResult(mandate)
    const exactInputs = { ...(rejected.payload as { exactInputs: object }).exactInputs, planActionId: 'other-plan' }
    const attempt =
      variant === 'crossed'
        ? [...records, implementStart(nextMandate), rejected]
        : [implementStart(mandate), withPayload(rejected, { exactInputs }), ...records]
    const evidence = await rootEvidence(historyFrom([...eligiblePlan(mandate, [historyFrom([mandate])]), ...attempt]))
    const decision = reconstructWorkflow({ evidence, facts: shippedFacts(nextMandate), decisions: decisions() })
    expect(decision).toMatchObject({ status: 'blocked', reason: 'unconfirmed' })
  })
})
