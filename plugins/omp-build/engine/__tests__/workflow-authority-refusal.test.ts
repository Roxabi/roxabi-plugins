import { describe, expect, test } from 'vitest'
import { observeFixtureNativeWorld } from '../../testing/action-input-fixtures.ts'
import { parseRecord } from '../record-construction.ts'
import type { Scope } from '../record-values.ts'
import { requireLandingMandate } from '../workflow-landing-admission.ts'
import { landingFixtures, nativeBody, nativeSnapshot } from './workflow-authority-native-fixture.ts'
import { binding, history, mandate, must, SCOPE } from './workflow-test-support.ts'

describe('workflow authority refusal behavior', () => {
  test('refuses a fix-only mandate at landing', async () => {
    const base = mandate()
    const record = must(
      parseRecord({
        ...base,
        payload: {
          ...base.payload,
          ownSpec: landingFixtures.ownSpecFromSnapshot(SCOPE, nativeSnapshot(SCOPE, nativeBody)),
        },
      }),
    )
    if (record.kind !== 'mandate') throw new Error('Expected a mandate')
    const pr: Scope = { repository: SCOPE.repository, target: 'acme/app#99' }
    const issue = history([record])
    const pullRequest = history([binding(record, pr)], pr)
    const code = 'b'.repeat(40)
    const causal = await observeFixtureNativeWorld({
      root: SCOPE,
      nodes: [
        {
          scope: SCOPE,
          title: 'Bounded workflow',
          body: nativeBody,
          updatedAt: '2026-10-21T00:00:00Z',
          labels: ['size:S'],
          parent: null,
          children: [],
          blockers: [],
          state: 'OPEN',
          stateReason: null,
        },
      ],
      histories: [issue, pullRequest],
      pullRequests: [
        {
          scope: pr,
          branch: 'feature/bounded',
          base: 'main',
          head: code,
          baseTip: code,
          state: 'OPEN',
          mergeCommit: null,
          author: 'operator',
        },
      ],
      commits: [],
      comparisons: [],
    })
    const config = record.payload.config
    const landing = requireLandingMandate({
      histories: causal.histories,
      authorityHistories: [issue, pullRequest],
      catalogues: causal.catalogues,
      observation: causal.observation,
      uwGraph: causal.observation.graph,
      native: { branch: 'feature/bounded', base: 'main', pullRequest: pr, linkedIssueScopes: [SCOPE] },
      parentScopes: [],
      localInhibit: null,
      current: {
        productVersion: config.productVersion,
        configVersion: config.version,
        configDigest: config.digest,
        supportedConfigVersions: [config.version],
        proposedSpec: { ok: true, snapshot: nativeSnapshot(SCOPE, nativeBody) },
        currentChildren: { ok: true, value: [] },
      },
    })
    expect(landing).toMatchObject({ ok: false, reason: 'fix-only' })
  })
})
