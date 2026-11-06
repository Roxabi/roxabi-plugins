import { describe, expect, it } from 'vitest'
import { selectApplicableMandate } from '../../engine/workflow-mandate-admission.ts'
import { observeFixtureNativeWorld } from '../action-input-fixtures.ts'
import { roxabiWorkflowFixtures } from '../roxabi-presets.ts'
import { nativeDecisionBody, nativeDecisionMandate } from './support/native-decision-spec.ts'
import { BODY, SCOPE } from './support/workflow-decision-fixtures.ts'

const { featureMandate, historyFrom } = roxabiWorkflowFixtures()

describe('workflow mandate selection', () => {
  it('refuses a second unrelated mandate instead of picking either', async () => {
    const first = nativeDecisionMandate(
      featureMandate(SCOPE, { recordId: 'mandate-a', operationId: 'op-mandate-a', body: BODY }),
    )
    const second = nativeDecisionMandate(
      featureMandate(SCOPE, {
        recordId: 'mandate-b',
        operationId: 'op-mandate-b',
        branch: 'feat/42-other',
        body: BODY,
      }),
    )
    const issue = historyFrom([first, second])
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
    expect(selectApplicableMandate(issue, [], causal)).toMatchObject({
      status: 'refused',
      reason: 'ambiguous',
    })
  })
})
