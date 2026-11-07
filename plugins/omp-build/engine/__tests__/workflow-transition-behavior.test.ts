import { describe, expect, test } from 'vitest'
import { workflowGraphData } from '../../roxabi/workflow-graph.ts'
import { observeFixtureNativeWorld } from '../../testing/action-input-fixtures.ts'
import { parseRecord } from '../record-construction.ts'
import { assessFixMandate } from '../workflow-correction-admission.ts'
import { workflowConditionSchema, workflowGraphActionSchema } from '../workflow-graph.ts'
import { requireLandingMandate } from '../workflow-landing-admission.ts'
import { selectWorkflowBinding } from '../workflow-pr-binding.ts'
import { reconstructWorkflow } from '../workflow-reconstruction-admission.ts'
import { BODY, binding, facts, history, mandate, must, PARENT, SCOPE } from './workflow-test-support.ts'
import {
  childCommitment,
  featureMandate,
  landingFixtures,
  landingInput,
  nativeBody,
  nativeCausal,
  parentNodes,
  parentSnapshot,
  pr,
  rootNode,
} from './workflow-transition-native-fixture.ts'

describe('workflow transition behavior', () => {
  test('routes a blocking parent review to reporting and rejects obsolete grouped-fix graph entries', () => {
    expect(workflowGraphData.edges).toContainEqual({ from: 'ready', to: 'report', when: 'epic-drop' })
    expect(workflowConditionSchema.safeParse('epic-fix-ticket').success).toBe(false)
    expect(workflowGraphActionSchema.safeParse('mark-fix').success).toBe(false)
  })

  test('blocks the first mandate when the session is not in the prepared worktree', async () => {
    const issue = history([])
    const causal = await observeFixtureNativeWorld({
      root: SCOPE,
      nodes: [
        {
          scope: SCOPE,
          title: 'Bounded workflow',
          body: BODY,
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
      facts: facts({ explicitSelection: true, sessionCwd: '/principal', preparedWorktree: '/work' }),
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
    expect(decision).toMatchObject({
      status: 'blocked',
      reason: 'session-cwd',
      evidence: [expect.objectContaining({ detail: { path: '/work', instruction: '/move /work' } })],
    })
  })
  test('lands a standalone feature through one binding and refuses absence, conflict, and an omitted epic parent', async () => {
    const feature = featureMandate()
    expect(
      requireLandingMandate(
        await landingInput(feature, [history([feature]), history([binding(feature, pr)], pr)], pr, [], [rootNode]),
      ),
    ).toMatchObject({
      ok: true,
      recordId: feature.recordId,
    })
    expect(
      requireLandingMandate(await landingInput(feature, [history([feature]), history([], pr)], pr, [], [rootNode])),
    ).toMatchObject({
      ok: false,
      reason: 'missing',
    })
    const other = must(parseRecord({ ...feature, recordId: 'mandate-2', operationId: 'op-mandate-2' }))
    expect(
      selectWorkflowBinding({
        pullRequest: pr,
        histories: [history([feature, other]), history([binding(feature, pr), binding(other, pr)], pr)],
        native: { branch: 'feature/bounded', base: 'main' },
      }).status,
    ).toBe('conflicting')
    const epic = landingFixtures.epicMandate(PARENT, [childCommitment], {
      recordId: 'epic-1',
      runId: 'abcd1234',
      operationId: 'op-epic',
      body: nativeBody,
      ownSpec: landingFixtures.ownSpecFromSnapshot(PARENT, parentSnapshot),
    })
    expect(
      requireLandingMandate(
        await landingInput(
          feature,
          [history([feature]), history([binding(feature, pr)], pr), history([epic], PARENT)],
          pr,
          [],
          parentNodes,
        ),
      ),
    ).toMatchObject({ ok: false, reason: 'missing' })
    const parent = landingFixtures.epicMandate(PARENT, [childCommitment], {
      recordId: 'parent-mandate',
      runId: 'run-1',
      operationId: 'op-parent',
      branch: 'feature/bounded',
      base: 'main',
      lineageHead: null,
      body: nativeBody,
      ownSpec: landingFixtures.ownSpecFromSnapshot(PARENT, parentSnapshot),
    })
    const requested = must(
      parseRecord({
        version: 1,
        repository: PARENT.repository,
        target: PARENT.target,
        recordId: 'parent-pause-requested',
        runId: 'run-1',
        operationId: 'op-parent-pause-requested',
        kind: 'operator-control',
        inputs: [parent.recordId],
        payload: {
          control: 'pause-requested',
          controlId: 'parent-control',
          predecessor: null,
          mandate: { scope: PARENT, recordId: parent.recordId, kind: 'mandate' },
        },
      }),
    )
    const confirmed = must(
      parseRecord({
        version: 1,
        repository: PARENT.repository,
        target: PARENT.target,
        recordId: 'parent-pause-confirmed',
        runId: 'run-1',
        operationId: 'op-parent-pause-confirmed',
        kind: 'operator-control',
        inputs: [parent.recordId, requested.recordId],
        payload: {
          control: 'pause-confirmed',
          controlId: 'parent-control',
          predecessor: { scope: PARENT, recordId: requested.recordId, kind: 'operator-control' },
          disarm: { observed: true, evidence: { source: 'host' } },
          mandate: { scope: PARENT, recordId: parent.recordId, kind: 'mandate' },
        },
      }),
    )
    const child = must(
      parseRecord({
        ...feature,
        recordId: 'child-mandate',
        operationId: 'op-child',
        payload: {
          ...feature.payload,
          parent: { scope: PARENT, recordId: parent.recordId, kind: 'mandate' },
          inheritedOwnSpecRefs: [
            {
              uw: PARENT,
              version: parent.payload.ownSpec.version,
              sourceAccepted: { scope: PARENT, recordId: parent.recordId, kind: 'mandate' },
            },
          ],
        },
      }),
    )
    if (child.kind !== 'mandate') throw new Error('fixture is not a mandate')
    expect(
      requireLandingMandate(
        await landingInput(
          child,
          [history([child]), history([binding(child, pr)], pr), history([parent, requested, confirmed], PARENT)],
          pr,
          [PARENT],
          parentNodes,
        ),
      ),
    ).toMatchObject({ ok: false, reason: 'paused' })
    expect(
      assessFixMandate({
        target: { scope: pr, kind: 'pull-request', branch: 'feature/bounded', base: 'main' },
        linkedIssueScopes: [],
        history: history([], pr),
        linkedIssueHistory: null,
        causal: await nativeCausal([history([mandate()]), history([], pr)], [rootNode]),
      }),
    ).toMatchObject({
      status: 'refused',
      reason: 'unknown-binding',
      evidence: [expect.objectContaining({ code: 'fix-own-uw-required' })],
    })
    expect(
      assessFixMandate({
        target: { scope: pr, kind: 'pull-request', branch: 'feature/bounded', base: 'main' },
        linkedIssueScopes: [],
        history: history([], pr),
        linkedIssueHistory: null,
        causal: await nativeCausal([history([]), history([], pr)], [rootNode]),
      }),
    ).toMatchObject({ status: 'refused', reason: 'unknown-binding' })
    expect(
      assessFixMandate({
        target: { scope: pr, kind: 'pull-request', branch: 'feature/bounded', base: 'main' },
        linkedIssueScopes: [SCOPE],
        history: history([], pr),
        linkedIssueHistory: null,
        causal: await nativeCausal([history([feature]), history([], pr)], [rootNode]),
      }),
    ).toMatchObject({ status: 'refused', reason: 'unknown-binding' })
  })
})
