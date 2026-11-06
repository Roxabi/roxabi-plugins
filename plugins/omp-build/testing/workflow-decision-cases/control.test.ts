import { describe, expect, it } from 'vitest'
import type { DecodedHistory } from '../../engine/history-schema.ts'
import { reconstructWorkflow } from '../../engine/workflow-reconstruction-admission.ts'
import { observeFixtureNativeWorld } from '../action-input-fixtures.ts'
import { roxabiWorkflowFixtures } from '../roxabi-presets.ts'
import { nativeDecisionBody, nativeDecisionMandate } from './support/native-decision-spec.ts'
import { BODY, decisions, factsForMandate, graphConfig, SCOPE } from './support/workflow-decision-fixtures.ts'

const { featureMandate, historyFrom, implementStart, pauseConfirmed, pauseRequested } = roxabiWorkflowFixtures()

async function evidence(issue: DecodedHistory) {
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

describe('workflow control decisions', () => {
  it('blocks native work when the session cwd is absent', async () => {
    const mandate = nativeDecisionMandate(featureMandate(SCOPE, { body: BODY }))
    const decision = reconstructWorkflow({
      evidence: await evidence(historyFrom([mandate])),
      facts: factsForMandate(mandate, { sessionCwd: null }),
      decisions: decisions(),
    })
    expect(decision).toMatchObject({ status: 'blocked', reason: 'session-cwd' })
    expect(decision).not.toMatchObject({ status: 'action' })
  })

  it('reports a confirmed pause and does not call it a review stop', async () => {
    const mandate = nativeDecisionMandate(featureMandate(SCOPE, { body: BODY }))
    const request = pauseRequested(mandate)
    const confirmed = pauseConfirmed(mandate, request)
    const decision = reconstructWorkflow({
      evidence: await evidence(historyFrom([mandate, request, confirmed])),
      facts: factsForMandate(mandate),
      decisions: decisions(),
    })
    expect(decision).toMatchObject({ status: 'paused', confirmed: true })
    expect(decision).not.toMatchObject({ status: 'terminal', reason: 'bound-stop' })
  })

  it('does not replay an implement start whose result is missing', async () => {
    const mandate = nativeDecisionMandate(featureMandate(SCOPE, { body: BODY, config: graphConfig('implement') }))
    const start = implementStart(mandate)
    const decision = reconstructWorkflow({
      evidence: await evidence(historyFrom([mandate, start])),
      facts: factsForMandate(mandate),
      decisions: decisions(),
    })
    expect(decision.status === 'action' && decision.action === 'implement').toBe(false)
    expect(decision).toMatchObject({ status: 'blocked', reason: 'action-uncertain' })
  })
})
