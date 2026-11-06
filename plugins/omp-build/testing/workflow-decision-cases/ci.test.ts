import { describe, expect, it } from 'vitest'
import { reconstructWorkflow } from '../../engine/workflow-reconstruction-admission.ts'
import { observeFixtureNativeWorld } from '../action-input-fixtures.ts'
import { roxabiWorkflowFixtures } from '../roxabi-presets.ts'
import { BODY, decisions, factsForMandate, graphConfig, SCOPE } from './support/workflow-decision-fixtures.ts'

const workflow = roxabiWorkflowFixtures()
const { featureMandate, historyFrom } = workflow

describe('workflow CI decisions', () => {
  it('does not lift a review-bound stop after a later green check', async () => {
    const mandate = featureMandate(SCOPE, { body: BODY, config: graphConfig('stop') })
    const issue = historyFrom([mandate])
    const causal = await observeFixtureNativeWorld({
      root: SCOPE,
      nodes: [
        {
          scope: SCOPE,
          title: 'Save the selected region',
          body: BODY,
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
    const decision = reconstructWorkflow({
      evidence: { issue, pullRequest: null, parents: [], causal },
      facts: factsForMandate(mandate),
      decisions: decisions('stop', 'green'),
    })
    expect(decision).toMatchObject({ status: 'terminal', reason: 'bound-stop' })
    expect(decision).not.toMatchObject({ status: 'action' })
  })
})
