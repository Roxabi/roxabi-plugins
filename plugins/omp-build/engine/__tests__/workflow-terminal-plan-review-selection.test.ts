import { expect, it } from 'vitest'
import { observeFixtureNativeWorld } from '../../testing/action-input-fixtures.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import {
  nativeDecisionBody,
  nativeDecisionMandate,
} from '../../testing/workflow-decision-cases/support/native-decision-spec.ts'
import {
  authenticatedPlanFixtures,
  BODY,
  decisions,
  eligiblePlan,
  SCOPE,
  shippedFacts,
} from '../../testing/workflow-decision-cases/support/workflow-decision-fixtures.ts'
import { actionInputDigest, canonicalValueDigest } from '../action-input.ts'
import { buildRecord } from '../record-construction.ts'
import { actionCompletion } from '../workflow-action-completion.ts'
import { inspectContextNegativeReceipt } from '../workflow-context-negative-inspection.ts'
import type { ActionReceiptPayload } from '../workflow-receipt-schema.ts'
import { reconstructWorkflow } from '../workflow-reconstruction-admission.ts'
import { assessFixture, mandateAssessmentState, proposedAssessmentState } from './workflow-spec-assessment-support.ts'

it.each([
  ['plan', 'invalid'],
  ['plan', 'withheld'],
  ['plan-review', 'invalid'],
  ['plan-review', 'withheld'],
] as const)('does not dispatch another plan after a retained %s %s terminal', async (action, terminal) => {
  const fixtures = roxabiWorkflowFixtures()
  const mandate = nativeDecisionMandate(fixtures.featureMandate(SCOPE, { body: BODY }))
  const workflow = authenticatedPlanFixtures(mandate, [fixtures.historyFrom([mandate])]).workflow
  const plan = workflow.planDraftRecords(mandate)
  const start =
    action === 'plan' ? plan[0] : workflow.planReviewStart(mandate, 'act-plan-1', workflow.publishedPlanDigest())
  if (start?.payload.phase !== 'start' || (start.payload.action !== 'plan-review' && start.payload.action !== 'plan'))
    throw new Error('missing plan or review start')
  const code = terminal === 'withheld' ? 'action-uncertain' : `${action}-output-invalid`
  const record = buildRecord({
    ...SCOPE,
    version: 1,
    recordId: `negative-${action}`,
    runId: mandate.runId,
    operationId: `negative-${action}-op`,
    kind: 'action-receipt',
    payload: {
      ...start.payload,
      phase: 'result',
      start: { scope: SCOPE, recordId: start.recordId, kind: 'action-receipt' },
      ...(start.payload.action === 'plan-review' ? { contributions: [] } : {}),
      native: { completion: 'completed', strict: terminal === 'invalid' ? 'invalid' : 'valid', raw: null },
      structured: null,
      admission: null,
      diagnostics: [{ code, message: code }],
    } as ActionReceiptPayload,
  })
  if (!record.ok) throw new Error(JSON.stringify(record.diagnostics))
  const issue = fixtures.historyFrom([mandate, ...(action === 'plan-review' ? plan : []), start, record.value])
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
  const evidence = { issue, pullRequest: null, parents: [], causal }
  const completion = actionCompletion('plan', evidence, decisions(), mandate)
  expect(['blocked', 'uncertain']).toContain(completion.status)
  const next = reconstructWorkflow({ evidence, facts: shippedFacts(mandate), decisions: decisions() })
  expect(next.status).toBe('blocked')
})

it('admits only an explicitly selected exact plan negative with new pinned context', async () => {
  const fixtures = roxabiWorkflowFixtures()
  const mandate = nativeDecisionMandate(fixtures.featureMandate(SCOPE, { body: BODY }))
  const workflow = authenticatedPlanFixtures(mandate, [fixtures.historyFrom([mandate])]).workflow
  const [start, original] = workflow.planDraftRecords(mandate)
  if (
    start?.payload.action !== 'plan' ||
    start.payload.phase !== 'start' ||
    original?.payload.action !== 'plan' ||
    original.payload.phase !== 'result'
  )
    throw new Error('expected plan pair')
  const result = buildRecord({
    ...SCOPE,
    version: 1,
    recordId: 'negative-plan-context',
    runId: mandate.runId,
    operationId: original.operationId,
    kind: 'action-receipt',
    payload: {
      ...original.payload,
      structured: {
        outcome: 'missing-context',
        missing: [
          {
            locator: { kind: 'information-request', description: 'Deployment region' },
            reason: 'Absent',
            targets: [],
          },
        ],
      },
      admission: null,
    },
  })
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics))
  const issue = fixtures.historyFrom([mandate, start, result.value])
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
  const evidence = { issue, pullRequest: null, parents: [], causal }
  const negative = { scope: SCOPE, kind: 'action-receipt' as const, recordId: result.value.recordId }
  const manifest = {
    ...start.payload.inputs.manifest,
    expandedContext: [
      {
        source: 'record' as const,
        record: negative,
        selector: '/payload',
        digest: canonicalValueDigest(result.value.payload),
      },
      {
        source: 'git-file' as const,
        repository: SCOPE.repository,
        commit: 'b'.repeat(40),
        path: 'region.txt',
        digest: 'a'.repeat(64),
      },
    ],
  }
  const inputs = { ...start.payload.inputs, manifest, fingerprint: actionInputDigest(manifest) }
  const facts = shippedFacts(mandate)
  expect(reconstructWorkflow({ evidence, facts, decisions: decisions() }).status).toBe('blocked')
  const recovery = { negative, actionId: 'expanded-plan', inputs }
  const recovered = reconstructWorkflow({
    evidence,
    facts: { ...facts, contextRecovery: recovery },
    decisions: decisions(),
  })
  expect(recovered, JSON.stringify(recovered)).toMatchObject({ status: 'action', action: 'plan' })
  expect(
    reconstructWorkflow({
      evidence,
      facts: {
        ...facts,
        contextRecovery: { ...recovery, negative: { ...negative, recordId: 'other-negative' } },
      },
      decisions: decisions(),
    }).status,
  ).toBe('blocked')
  expect(
    reconstructWorkflow({
      evidence,
      facts: {
        ...facts,
        contextRecovery: { ...recovery, inputs: start.payload.inputs },
      },
      decisions: decisions(),
    }).status,
  ).toBe('blocked')
})

it('refuses a projected review negative when all specialist judgments are positive', () => {
  const fixtures = roxabiWorkflowFixtures()
  const mandate = nativeDecisionMandate(fixtures.featureMandate(SCOPE, { body: BODY }))
  const records = eligiblePlan(mandate, [fixtures.historyFrom([mandate])])
  const positive = records.at(-1)
  if (
    positive?.kind !== 'action-receipt' ||
    positive.payload.action !== 'plan-review' ||
    positive.payload.phase !== 'result'
  )
    throw new Error('Expected positive review result')
  const projected = buildRecord({
    ...positive,
    payload: {
      ...positive.payload,
      structured: {
        outcome: 'missing-context',
        missing: [
          {
            locator: { kind: 'information-request', description: 'Deployment region' },
            reason: 'Absent',
            targets: [],
          },
        ],
      },
      admission: null,
    },
  })
  if (!projected.ok) throw new Error(JSON.stringify(projected.diagnostics))
  const issue = fixtures.historyFrom([...records.slice(0, -1), projected.value])
  const negative = {
    source: 'record' as const,
    record: { scope: SCOPE, kind: 'action-receipt' as const, recordId: projected.value.recordId },
    selector: '/payload' as const,
    digest: canonicalValueDigest(projected.value.payload),
  }
  expect(inspectContextNegativeReceipt({ mandate, histories: [issue], negative }).ok).toBe(false)
})

it('never treats independent plan and assessment negatives as one disposable chain', () => {
  const fixtures = roxabiWorkflowFixtures()
  const mandate = nativeDecisionMandate(fixtures.featureMandate(SCOPE, { body: BODY }))
  const initial = fixtures.historyFrom([mandate])
  const workflow = authenticatedPlanFixtures(mandate, [initial]).workflow
  const [planStart, originalPlan] = workflow.planDraftRecords(mandate)
  if (
    planStart?.kind !== 'action-receipt' ||
    originalPlan?.kind !== 'action-receipt' ||
    originalPlan.payload.action !== 'plan' ||
    originalPlan.payload.phase !== 'result'
  )
    throw new Error('Plan pair unavailable')
  const accepted = mandateAssessmentState(mandate)
  const proposed = proposedAssessmentState(accepted, { body: BODY })
  const assess = assessFixture(mandate, 'independent-assess', accepted, proposed, null, [initial])
  if (
    assess.start.kind !== 'action-receipt' ||
    assess.start.payload.action !== 'assess-spec' ||
    assess.start.payload.phase !== 'start'
  )
    throw new Error('Assessment start unavailable')
  const missing = {
    outcome: 'missing-context' as const,
    missing: [
      {
        locator: { kind: 'information-request' as const, description: 'Deployment region' },
        reason: 'Absent',
        targets: [],
      },
    ],
  }
  const raw = {
    id: 'native-child',
    agent: 'native-child',
    exitCode: 0,
    structuredOutput: { status: 'valid', data: missing },
  }
  const configured = (inputs: typeof planStart.payload.inputs) => {
    const manifest = {
      ...inputs.manifest,
      configuration: {
        version: mandate.payload.config.version,
        digest: mandate.payload.config.digest,
        serialized: JSON.stringify(mandate.payload.config.effective),
      },
    }
    return { ...inputs, manifest, fingerprint: actionInputDigest(manifest) }
  }
  const planInputs = configured(planStart.payload.inputs)
  const assessmentInputs = configured(assess.start.payload.inputs)
  const configuredPlanStart = buildRecord({ ...planStart, payload: { ...planStart.payload, inputs: planInputs } })
  const configuredAssessmentStart = buildRecord({
    ...assess.start,
    payload: { ...assess.start.payload, inputs: assessmentInputs },
  })
  const plan = buildRecord({
    ...originalPlan,
    payload: {
      ...originalPlan.payload,
      inputs: planInputs,
      structured: missing,
      native: { completion: 'completed', strict: 'valid', raw },
      admission: null,
    },
  })
  const assessment = buildRecord({
    ...assess.result,
    payload: {
      ...assess.result.payload,
      inputs: assessmentInputs,
      structured: missing,
      native: { completion: 'completed', strict: 'valid', raw },
      admission: null,
    },
  })
  if (!plan.ok || !assessment.ok || !configuredPlanStart.ok || !configuredAssessmentStart.ok)
    throw new Error('Negative fixture records malformed')
  const planHistory = fixtures.historyFrom([mandate, configuredPlanStart.value, plan.value])
  const assessHistory = fixtures.historyFrom([mandate, configuredAssessmentStart.value, assessment.value])
  const both = fixtures.historyFrom([
    mandate,
    configuredPlanStart.value,
    plan.value,
    configuredAssessmentStart.value,
    assessment.value,
  ])
  const pin = (record: typeof plan.value) => ({
    source: 'record' as const,
    record: { scope: SCOPE, kind: 'action-receipt' as const, recordId: record.recordId },
    selector: '/payload' as const,
    digest: canonicalValueDigest(record.payload),
  })
  const planInspection = inspectContextNegativeReceipt({ mandate, histories: [planHistory], negative: pin(plan.value) })
  const assessmentInspection = inspectContextNegativeReceipt({
    mandate,
    histories: [assessHistory],
    negative: pin(assessment.value),
  })
  expect(planInspection.ok, JSON.stringify(planInspection)).toBe(true)
  expect(assessmentInspection.ok, JSON.stringify(assessmentInspection)).toBe(true)
  expect(inspectContextNegativeReceipt({ mandate, histories: [both], negative: pin(plan.value) }).ok).toBe(false)
  expect(inspectContextNegativeReceipt({ mandate, histories: [both], negative: pin(assessment.value) }).ok).toBe(false)
})
