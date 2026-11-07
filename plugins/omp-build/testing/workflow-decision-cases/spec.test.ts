import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { selectApplicableMandate } from '../../engine/workflow-mandate-admission.ts'
import { observeFixtureNativeWorld } from '../action-input-fixtures.ts'
import { roxabiWorkflowFixtures } from '../roxabi-presets.ts'
import { nativeDecisionBody, nativeDecisionMandate } from './support/native-decision-spec.ts'
import { BODY, blank, SCOPE } from './support/workflow-decision-fixtures.ts'

const { featureMandate } = roxabiWorkflowFixtures()

describe('workflow decision specification authority', () => {
  it('does not treat a mandate object outside the history as authority', async () => {
    const held = nativeDecisionMandate(featureMandate(SCOPE, { body: BODY }))
    expect(held.kind).toBe('mandate')
    const issue = blank()
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
      reason: 'missing',
    })
  })

  it('pins the mandate product version to installed package metadata', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
    const mandate = featureMandate(SCOPE)
    if (mandate.kind !== 'mandate') throw new Error('expected a mandate')
    expect(mandate.payload.config.productVersion).toBe(pkg.version)
  })
})
