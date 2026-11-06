import { describe, expect, it } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { parseIssueSpecBody, rawSource } from '../../adapters/github-native/uw-spec.ts'
import type { DecodedHistory } from '../../engine/history-schema.ts'
import { reconstructWorkflow } from '../../engine/workflow-reconstruction-admission.ts'
import { ROXABI_STOP_AUTHOR } from '../../roxabi/github-policy.ts'
import { strictSpecBody } from '../../skills/feature/testing/epic-driver/epic-driver-records.ts'
import { type FixtureNativeWorld, observeFixtureNativeWorld } from '../action-input-fixtures.ts'
import { nativeImplementationWorld } from '../native-implementation-world.ts'
import { roxabiWorkflowFixtures } from '../roxabi-presets.ts'
import {
  BODY,
  blank,
  decisions,
  EPIC,
  eligiblePlan,
  hasAction,
  PR,
  SCOPE,
  shippedFacts,
} from './support/workflow-decision-fixtures.ts'

const workflow = roxabiWorkflowFixtures()
const { childSnapshot, epicMandate, featureMandate, historyFrom, workflowBinding } = workflow

describe('workflow CI decisions', () => {
  it('dispatches publish, a bound first or moved-head review, and land without a duplicate receipt', async () => {
    const body = strictSpecBody('Save keeps the selected region')
    const parsed = parseIssueSpecBody({ uw: SCOPE, raw: rawSource(SCOPE.target, body, '2026-10-21T12:00:00Z') })
    if (parsed.status !== 'conformant') throw new Error('Expected a conformant native Spec')
    const mandate = featureMandate(SCOPE, { body, ownSpec: workflow.ownSpecFromSnapshot(SCOPE, parsed.snapshot) })
    const startHead = 'b'.repeat(40)
    const head = 'c'.repeat(40)
    const initial = historyFrom(eligiblePlan(mandate, [historyFrom([mandate])]))
    const rootNode = {
      scope: SCOPE,
      title: 'Save the selected region',
      body,
      updatedAt: '2026-10-21T12:00:00Z',
      labels: ['size:S'],
      parent: null,
      children: [],
      blockers: [],
      state: 'OPEN' as const,
      stateReason: null,
    }
    const seed = await observeFixtureNativeWorld({
      root: SCOPE,
      nodes: [rootNode],
      histories: [initial],
      pullRequests: [],
      commits: [],
      comparisons: [],
    })
    const commits = [
      {
        sha: startHead,
        parents: [],
        tree: 'c'.repeat(40),
        subject: 'fixture base',
        paths: ['fixture.txt'],
        config: null,
      },
      {
        sha: head,
        parents: [startHead],
        tree: 'd'.repeat(40),
        subject: 'feat: implement fixture (#42)',
        paths: ['fixture.txt'],
        config: null,
      },
    ]
    if (seed.observation.graph.status !== 'complete') throw new Error('Native graph unavailable')
    const produced = await nativeImplementationWorld({
      graph: seed.observation.graph,
      histories: [initial],
      scope: SCOPE,
      mandate,
      startHead,
      head,
      branch: 'feat/42-save',
      command: 'bun test',
      output: 'PASS',
      author: 'operator',
      baseTip: startHead,
      remoteTipBefore: startHead,
      remoteTipAfter: head,
      pullRequestsBefore: [],
      pullRequestsAfter: [],
      comparisons: [],
      commits,
    })
    const issue = produced.history
    expect(issue.source.stopAuthor).toBe(ROXABI_STOP_AUTHOR)
    const pull = { scope: PR, head: 'feat/42-save', base: 'main', associatedIssue: SCOPE }
    const bound = historyFrom([workflowBinding(PR, mandate, 'feat/42-save', 'main')], 'operator', 'operator', [issue])
    const nativePulls: FixtureNativeWorld['pullRequests'] = [
      {
        scope: PR,
        branch: 'feat/42-save',
        base: 'main',
        head,
        baseTip: startHead,
        state: 'OPEN',
        mergeCommit: null,
        author: 'operator',
      },
    ]
    const unrelatedNode = {
      scope: EPIC,
      title: 'Unrelated epic',
      body: BODY,
      updatedAt: '2026-10-21T12:00:00Z',
      labels: ['size:S'],
      parent: null,
      children: [],
      blockers: [],
      state: 'OPEN' as const,
      stateReason: null,
    }
    const evidence = async (
      selected: DecodedHistory,
      pullRequest: DecodedHistory | null,
      extra: DecodedHistory[],
      nodes: (typeof rootNode)[],
      pullRequests: FixtureNativeWorld['pullRequests'],
    ) => {
      const applyPolicy = (history: DecodedHistory) =>
        history.source.stopAuthor === ROXABI_STOP_AUTHOR
          ? history
          : decodeHistory({ ...history.source, stopAuthor: ROXABI_STOP_AUTHOR })
      const issue = applyPolicy(selected)
      const boundPull = pullRequest === null ? null : applyPolicy(pullRequest)
      const causal = await observeFixtureNativeWorld(
        {
          root: SCOPE,
          nodes,
          histories: [issue, ...(boundPull === null ? [] : [boundPull]), ...extra.map(applyPolicy)],
          pullRequests,
          commits: commits.map(({ sha, parents }) => ({ repository: SCOPE.repository, sha, parents })),
          comparisons: [
            { repository: SCOPE.repository, base: startHead, head: startHead, status: 'identical', commits: [] },
          ],
        },
        { stopAuthor: ROXABI_STOP_AUTHOR },
      )
      return { issue, pullRequest: boundPull, parents: [], causal }
    }
    const published = await evidence(issue, null, [], [rootNode], [])
    expect(hasAction(published.issue, 'publish')).toBe(false)
    expect(
      reconstructWorkflow({
        evidence: published,
        facts: { ...shippedFacts(mandate), candidateGitSHA: head },
        decisions: decisions(),
      }),
    ).toMatchObject({
      status: 'action',
      action: 'publish',
    })
    const unrelated = epicMandate(EPIC, [childSnapshot(SCOPE, BODY)])
    const causalOnly = historyFrom([unrelated])
    expect(
      reconstructWorkflow({
        evidence: await evidence(issue, null, [causalOnly], [rootNode, unrelatedNode], []),
        facts: { ...shippedFacts(mandate), candidateGitSHA: head },
        decisions: decisions(),
      }),
    ).toMatchObject({ status: 'action', action: 'publish', mandateId: mandate.recordId })
    const afterPublished = { ...decisions(), publish: { status: 'published' as const, evidence: [] } }
    const barePull = await evidence(historyFrom([mandate]), blank(PR), [], [rootNode], nativePulls)
    const bareDecision = reconstructWorkflow({
      evidence: barePull,
      facts: { ...shippedFacts(mandate, pull), candidateGitSHA: head },
      decisions: decisions(),
    })
    expect(bareDecision).toMatchObject({ status: 'action', action: 'plan' })
    const review = await evidence(issue, bound, [], [rootNode], nativePulls)
    expect(hasAction(review.issue, 'review')).toBe(false)
    expect(
      reconstructWorkflow({
        evidence: review,
        facts: { ...shippedFacts(mandate, pull), candidateGitSHA: head },
        decisions: afterPublished,
      }),
    ).toMatchObject({
      status: 'action',
      action: 'review',
    })
    const movedCandidate = '2222222222222222222222222222222222222222'
    expect(
      reconstructWorkflow({
        evidence: review,
        facts: { ...shippedFacts(mandate, pull), candidateGitSHA: movedCandidate },
        decisions: afterPublished,
      }),
    ).toMatchObject({ status: 'action', action: 'review' })
    expect(hasAction(review.issue, 'land')).toBe(false)
    expect(
      reconstructWorkflow({
        evidence: review,
        facts: { ...shippedFacts(mandate, pull), candidateGitSHA: head },
        decisions: { ...afterPublished, reviewStep: 'land' },
      }),
    ).toMatchObject({ status: 'action', action: 'land' })
  })
})
