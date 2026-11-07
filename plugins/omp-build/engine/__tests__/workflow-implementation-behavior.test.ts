import { describe, expect, test } from 'vitest'
import { parseIssueSpecBody, rawSource } from '../../adapters/github-native/uw-spec.ts'
import { strictSpecBody } from '../../skills/feature/testing/epic-driver/epic-driver-records.ts'
import { observeFixtureNativeWorld } from '../../testing/action-input-fixtures.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { reconstructWorkflow } from '../workflow-reconstruction-admission.ts'
import { facts, history, SCOPE } from './workflow-test-support.ts'

const nativeBody = strictSpecBody('ship the bounded workflow')
const parsed = parseIssueSpecBody({ uw: SCOPE, raw: rawSource(SCOPE.target, nativeBody, '2026-10-21T00:00:00Z') })
if (parsed.status !== 'conformant') throw new Error('Expected conformant native Spec')
const ownSpec = roxabiWorkflowFixtures().ownSpecFromSnapshot(SCOPE, parsed.snapshot)

describe('workflow implementation behavior', () => {
  test('does not dispatch implementation when a pinned graph reaches it without a confirmed plan', async () => {
    const workflow = roxabiWorkflowFixtures()
    const baseline = workflow.featureMandate(SCOPE, { body: nativeBody, ownSpec })
    const graph = {
      version: 1,
      productVersion: baseline.payload.config.productVersion,
      configVersion: baseline.payload.config.version,
      edgeOrder: 'array' as const,
      nodes: [{ id: 'implement', action: 'implement' as const }],
      edges: [],
      initial: 'implement',
    }
    const mandated = workflow.featureMandate(SCOPE, {
      body: nativeBody,
      ownSpec,
      config: {
        version: baseline.payload.config.version,
        digest: baseline.payload.config.digest,
        effective: { graph },
      },
    })
    const issue = history([mandated])
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
      histories: [issue],
      pullRequests: [],
      commits: [],
      comparisons: [],
    })
    const decision = reconstructWorkflow({
      evidence: { issue, pullRequest: null, parents: [], causal },
      facts: facts({
        productVersion: mandated.payload.config.productVersion,
        configVersion: mandated.payload.config.version,
        configDigest: mandated.payload.config.digest,
        supportedConfigVersions: [mandated.payload.config.version],
      }),
      decisions: {
        reviewStep: null,
        epicStep: null,
        epicLand: null,
        ciWatchStatus: null,
        publish: { status: 'absent', evidence: [] },
        landing: { status: 'absent', evidence: [] },
        watch: { status: 'absent', evidence: [] },
      },
    })
    expect(decision).toMatchObject({ status: 'blocked', reason: 'unknown-outcome' })
    expect(decision).not.toMatchObject({ status: 'action', action: 'implement' })
  })
})
