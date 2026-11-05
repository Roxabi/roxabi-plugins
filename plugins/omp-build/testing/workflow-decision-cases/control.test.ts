import { describe, expect, it } from 'vitest'
import { reconstructWorkflow } from '../../engine/workflow-reconstruction-admission.ts'
import { workflowEvidence } from '../action-input-fixtures.ts'
import { roxabiWorkflowFixtures } from '../roxabi-presets.ts'
import { BODY, decisions, factsForMandate, graphConfig, SCOPE } from './support/workflow-decision-fixtures.ts'

const { featureMandate, historyFrom, implementStart, pauseConfirmed, pauseRequested } = roxabiWorkflowFixtures()

describe('workflow control decisions', () => {
  it('blocks native work when the session cwd is absent', () => {
    const mandate = featureMandate(SCOPE, { body: BODY })
    const decision = reconstructWorkflow({
      evidence: workflowEvidence(historyFrom([mandate]), null, [], []),
      facts: factsForMandate(mandate, { sessionCwd: null }),
      decisions: decisions(),
    })
    expect(decision).toMatchObject({ status: 'blocked', reason: 'session-cwd' })
    expect(decision).not.toMatchObject({ status: 'action' })
  })

  it('reports a confirmed pause and does not call it a review stop', () => {
    const mandate = featureMandate(SCOPE, { body: BODY })
    const request = pauseRequested(mandate)
    const confirmed = pauseConfirmed(mandate, request)
    const decision = reconstructWorkflow({
      evidence: workflowEvidence(historyFrom([mandate, request, confirmed]), null, [], []),
      facts: factsForMandate(mandate),
      decisions: decisions(),
    })
    expect(decision).toMatchObject({ status: 'paused', confirmed: true })
    expect(decision).not.toMatchObject({ status: 'terminal', reason: 'bound-stop' })
  })

  it('does not replay an implement start whose result is missing', () => {
    const mandate = featureMandate(SCOPE, { body: BODY, config: graphConfig('implement') })
    const start = implementStart(mandate)
    const decision = reconstructWorkflow({
      evidence: workflowEvidence(historyFrom([mandate, start]), null, [], []),
      facts: factsForMandate(mandate),
      decisions: decisions(),
    })
    expect(decision.status === 'action' && decision.action === 'implement').toBe(false)
    expect(decision).toMatchObject({ status: 'blocked', reason: 'action-uncertain' })
  })
})
