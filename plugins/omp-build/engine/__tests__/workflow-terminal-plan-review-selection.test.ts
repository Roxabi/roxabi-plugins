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
  SCOPE,
  shippedFacts,
} from '../../testing/workflow-decision-cases/support/workflow-decision-fixtures.ts'
import { buildRecord } from '../record-construction.ts'
import { actionCompletion } from '../workflow-action-completion.ts'
import type { ActionReceiptPayload } from '../workflow-receipt-schema.ts'
import { reconstructWorkflow } from '../workflow-reconstruction-admission.ts'

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
