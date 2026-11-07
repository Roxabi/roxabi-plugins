import { describe, expect, test } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { parseIssueSpecBody, rawSource } from '../../adapters/github-native/uw-spec.ts'
import { strictSpecBody } from '../../skills/feature/testing/epic-driver/epic-driver-records.ts'
import { type FixtureNativeWorld, observeFixtureNativeWorld } from '../../testing/action-input-fixtures.ts'
import { nativeImplementationWorld } from '../../testing/native-implementation-world.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { authenticatedPlanFixtures } from '../../testing/workflow-decision-cases/support/workflow-decision-fixtures.ts'
import type { DecodedHistory } from '../history-schema.ts'
import { buildRecord } from '../record-construction.ts'
import type { Scope } from '../record-values.ts'
import { resolveSpecEffective } from '../spec-effective.ts'
import { resolveAcceptedSpec } from '../workflow-accepted-spec.ts'
import { recordsOf } from '../workflow-control.ts'
import { selectApplicableMandate } from '../workflow-mandate-admission.ts'
import { planMacro } from '../workflow-plan-macro.ts'
import { reconstructWorkflow } from '../workflow-reconstruction-admission.ts'
import type { SpecializedDecisions } from '../workflow-reconstruction-types.ts'
import { implementationStart } from './workflow-implementation-support.ts'
import { assessFixture, mandateAssessmentState, proposedAssessmentState } from './workflow-spec-assessment-support.ts'
import { binding, facts, history, must, SCOPE } from './workflow-test-support.ts'

async function planEvidence(
  issue: DecodedHistory,
  pullRequest: DecodedHistory | null,
  body: string,
  pullRequests: FixtureNativeWorld['pullRequests'],
  gitFacts: Pick<FixtureNativeWorld, 'commits' | 'comparisons'> = { commits: [], comparisons: [] },
) {
  // Re-decode the same native comments under this fixture reader's explicit null stop-author policy.
  const issueCut = decodeHistory({ ...issue.source, stopAuthor: null })
  const pullCut = pullRequest === null ? null : decodeHistory({ ...pullRequest.source, stopAuthor: null })
  const causal = await observeFixtureNativeWorld({
    root: SCOPE,
    nodes: [
      {
        scope: SCOPE,
        title: 'Bounded workflow',
        body,
        updatedAt: '2026-10-21T00:00:00Z',
        labels: ['size:S'],
        parent: null,
        children: [],
        blockers: [],
        state: 'OPEN',
        stateReason: null,
      },
    ],
    histories: [issueCut, ...(pullCut === null ? [] : [pullCut])],
    pullRequests,
    commits: gitFacts.commits,
    comparisons: [
      ...gitFacts.comparisons,
      { repository: SCOPE.repository, base: 'b'.repeat(40), head: 'b'.repeat(40), status: 'identical', commits: [] },
    ],
  })
  return { issue: issueCut, pullRequest: pullCut, parents: [], causal }
}

describe('workflow plan execution behavior', () => {
  test('binds plan receipts and implementation to the accepted canonical Spec version after editorial advancement', async () => {
    const workflow = roxabiWorkflowFixtures()
    const originalBody = strictSpecBody('Ship the bounded workflow')
    const currentBody = strictSpecBody('Editorial body')
    const original = parseIssueSpecBody({
      uw: SCOPE,
      raw: rawSource(SCOPE.target, originalBody, '2026-10-21T00:00:00Z'),
    })
    const current = parseIssueSpecBody({ uw: SCOPE, raw: rawSource(SCOPE.target, currentBody, '2026-10-21T00:00:00Z') })
    if (original.status !== 'conformant' || current.status !== 'conformant')
      throw new Error('Expected native Spec snapshots')
    const currentContent = {
      criteria: current.snapshot.spec.criteria,
      invariants: current.snapshot.spec.invariants,
      exclusions: current.snapshot.spec.exclusions,
      openQuestions: current.snapshot.spec.openQuestions,
      sections: current.snapshot.spec.sections,
    }
    const mandated = workflow.featureMandate(SCOPE, {
      recordId: 'mandate-1',
      runId: 'run-1',
      operationId: 'op-mandate-1',
      branch: 'feature/bounded',
      base: 'main',
      lineageHead: null,
      body: originalBody,
      ownSpec: workflow.ownSpecFromSnapshot(SCOPE, original.snapshot),
    })
    const initial = mandateAssessmentState(mandated)
    const originalVersion = initial.ref.version
    const editorial = assessFixture(
      mandated,
      'edit',
      initial,
      proposedAssessmentState(initial, { body: currentBody, content: currentContent }),
      'editorial',
      [history([mandated])],
    )
    const advancedVersion = editorial.currentVersion
    expect(advancedVersion).not.toBe(originalVersion)
    const digest = workflow.publishedPlanDigest()
    const oldWorkflow = authenticatedPlanFixtures(mandated, [history([mandated])]).workflow

    const [oldStart, oldResult] = oldWorkflow.planDraftRecords(mandated, 'act-plan-a', originalVersion)
    const oldReviewStart = oldWorkflow.planReviewStart(
      mandated,
      'act-plan-a',
      digest,
      'act-plan-review-a',
      originalVersion,
    )
    const oldReview = oldWorkflow.planReviewRecord(
      mandated,
      'act-plan-a',
      digest,
      [
        workflow.clearPlanContribution('slot-architect', 'R-workflow-plan-architect'),
        workflow.clearPlanContribution('slot-adversarial', 'R-workflow-plan-adversarial'),
      ],
      'act-plan-review-a',
      originalVersion,
    )
    const oldReady = history([mandated, oldStart, oldResult, oldReviewStart, oldReview])
    const oldSeed = await planEvidence(oldReady, null, originalBody, [])
    if (oldSeed.causal.observation.graph.status !== 'complete') throw new Error('Expected complete old graph')
    const oldWorld = await nativeImplementationWorld({
      graph: oldSeed.causal.observation.graph,
      histories: [oldReady],
      scope: SCOPE,
      mandate: mandated,
      author: 'operator',
      startHead: 'b'.repeat(40),
      head: 'a'.repeat(40),
      baseTip: 'b'.repeat(40),
      remoteTipBefore: 'b'.repeat(40),
      remoteTipAfter: 'a'.repeat(40),
      pullRequestsBefore: [],
      pullRequestsAfter: [],
      comparisons: [],
      commits: [
        {
          sha: 'b'.repeat(40),
          parents: [],
          tree: 'd'.repeat(40),
          subject: 'fixture base',
          paths: ['fixture.txt'],
          config: null,
        },
        {
          sha: 'a'.repeat(40),
          parents: ['b'.repeat(40)],
          tree: 'c'.repeat(40),
          subject: 'feat: implement fixture (#42)',
          paths: ['fixture.txt'],
          config: null,
        },
      ],
      branch: 'feature/bounded',
      command: 'bun test',
      output: 'PASS',
    })
    const oldRecords = recordsOf(oldWorld.history)
    const advanced = history([...oldRecords, editorial.start, editorial.result])
    const stale = planMacro(await planEvidence(advanced, null, currentBody, []), mandated)
    expect(stale).toMatchObject({
      phase: 'needs-draft',
      specDigest: advancedVersion,
    })
    expect(stale.phase).not.toBe('eligible')
    const advancedAccepted = resolveAcceptedSpec(mandated, [advanced])
    if (!advancedAccepted.ok) throw new Error('Expected authenticated advanced Spec')
    const advancedEffective = must(
      resolveSpecEffective({
        mode: 'historical',
        own: advancedAccepted.spec.ref,
        versionVector: [advancedAccepted.spec.ref, ...advancedAccepted.spec.inheritedOwnSpecRefs],
        histories: [advanced],
      }),
    )
    const advancedWorkflow = authenticatedPlanFixtures(mandated, [advanced], advancedEffective).workflow

    const [newStart, newResult] = advancedWorkflow.planDraftRecords(mandated, 'act-plan-b', advancedVersion)
    const newReviewStart = advancedWorkflow.planReviewStart(
      mandated,
      'act-plan-b',
      digest,
      'act-plan-review-b',
      advancedVersion,
    )
    const newReview = advancedWorkflow.planReviewRecord(
      mandated,
      'act-plan-b',
      digest,
      [
        workflow.clearPlanContribution('slot-architect', 'R-workflow-plan-architect'),
        workflow.clearPlanContribution('slot-adversarial', 'R-workflow-plan-adversarial'),
      ],
      'act-plan-review-b',
      advancedVersion,
    )
    const eligibleRecords = [
      ...oldRecords,
      editorial.start,
      editorial.result,
      newStart,
      newResult,
      newReviewStart,
      newReview,
    ]
    const bound = planMacro(await planEvidence(history(eligibleRecords), null, currentBody, []), mandated)
    expect(bound).toMatchObject({
      phase: 'eligible',
      specDigest: advancedVersion,
      draftActionId: 'act-plan-b',
      reviewActionId: 'act-plan-review-b',
    })
    const workflowFacts = facts({
      productVersion: mandated.payload.config.productVersion,
      currentSpec: editorial.proposed,
      identityAllocations: mandated.payload.ownSpec.identityAllocations,
      configVersion: mandated.payload.config.version,
      configDigest: mandated.payload.config.digest,
      supportedConfigVersions: [mandated.payload.config.version],
    })
    const workflowDecisions: SpecializedDecisions = {
      reviewStep: null,
      epicStep: null,
      epicLand: null,
      ciWatchStatus: null,
      publish: { status: 'absent', evidence: [] },
      landing: { status: 'absent', evidence: [] },
      watch: { status: 'absent', evidence: [] },
    }
    const currentReady = history(eligibleRecords)
    const currentSeed = await planEvidence(currentReady, null, currentBody, [])
    if (currentSeed.causal.observation.graph.status !== 'complete') throw new Error('Expected complete current graph')
    const currentWorld = await nativeImplementationWorld({
      graph: currentSeed.causal.observation.graph,
      histories: [currentReady],
      scope: SCOPE,
      mandate: mandated,
      author: 'operator',
      startHead: 'b'.repeat(40),
      head: 'a'.repeat(40),
      baseTip: 'b'.repeat(40),
      remoteTipBefore: 'b'.repeat(40),
      remoteTipAfter: 'a'.repeat(40),
      pullRequestsBefore: [],
      pullRequestsAfter: [],
      comparisons: [],
      commits: [
        {
          sha: 'b'.repeat(40),
          parents: [],
          tree: 'd'.repeat(40),
          subject: 'fixture base',
          paths: ['fixture.txt'],
          config: null,
        },
        {
          sha: 'a'.repeat(40),
          parents: ['b'.repeat(40)],
          tree: 'c'.repeat(40),
          subject: 'feat: implement fixture (#42)',
          paths: ['fixture.txt'],
          config: null,
        },
      ],
      branch: 'feature/bounded',
      command: 'bun test',
      output: 'PASS',
    })
    const currentImplementationStart = recordsOf(currentWorld.history).find(
      (record) => record.kind === 'action-receipt' && record.recordId === currentWorld.opened.start.recordId,
    )
    if (!currentImplementationStart) throw new Error('Expected the published implementation START')
    const currentImplementation = reconstructWorkflow({
      evidence: await planEvidence(currentReady, null, currentBody, []),
      facts: workflowFacts,
      decisions: workflowDecisions,
    })
    expect(currentImplementation).toMatchObject({ status: 'action', action: 'implement' })

    const unmatchedOldStart = implementationStart(mandated, 'act-implement-open', 'act-plan-a')
    const oldUncertain = reconstructWorkflow({
      evidence: await planEvidence(
        history([
          mandated,
          editorial.start,
          editorial.result,
          oldStart,
          oldResult,
          oldReviewStart,
          oldReview,
          unmatchedOldStart,
        ]),
        null,
        currentBody,
        [],
      ),
      facts: workflowFacts,
      decisions: workflowDecisions,
    })
    expect(oldUncertain).toMatchObject({ status: 'blocked', reason: 'action-uncertain' })

    const currentUncertain = reconstructWorkflow({
      evidence: await planEvidence(history([...eligibleRecords, currentImplementationStart]), null, currentBody, []),
      facts: workflowFacts,
      decisions: workflowDecisions,
    })
    expect(currentUncertain).toMatchObject({ status: 'blocked', reason: 'action-uncertain' })

    const published = reconstructWorkflow({
      evidence: await planEvidence(currentWorld.history, null, currentBody, []),
      facts: workflowFacts,
      decisions: workflowDecisions,
    })
    expect(published).toMatchObject({ status: 'action', action: 'publish' })
    const pull: Scope = { repository: SCOPE.repository, target: 'acme/app#99' }
    const boundPull = history([binding(mandated, pull)], pull)
    const review = reconstructWorkflow({
      evidence: await planEvidence(
        currentWorld.history,
        boundPull,
        currentBody,
        [
          {
            scope: pull,
            branch: 'feature/bounded',
            base: 'main',
            head: 'a'.repeat(40),
            baseTip: 'b'.repeat(40),
            state: 'OPEN',
            mergeCommit: null,
            author: 'operator',
          },
        ],
        {
          commits: [
            { repository: SCOPE.repository, sha: 'b'.repeat(40), parents: [] },
            { repository: SCOPE.repository, sha: 'a'.repeat(40), parents: ['b'.repeat(40)] },
          ],
          comparisons: [
            {
              repository: SCOPE.repository,
              base: 'b'.repeat(40),
              head: 'a'.repeat(40),
              status: 'ahead',
              commits: ['a'.repeat(40)],
            },
          ],
        },
      ),
      facts: {
        ...workflowFacts,
        candidateGitSHA: 'a'.repeat(40),
        pullRequest: { scope: pull, head: 'feature/bounded', base: 'main', associatedIssue: SCOPE },
      },
      decisions: { ...workflowDecisions, publish: { status: 'published', evidence: [] } },
    })
    expect(review, JSON.stringify(review, null, 2)).toMatchObject({ status: 'action', action: 'review' })

    const mandateRef = { scope: SCOPE, recordId: mandated.recordId, kind: 'mandate' as const }
    const abandoned = must(
      buildRecord({
        version: 1,
        repository: SCOPE.repository,
        target: SCOPE.target,
        recordId: 'abandon-mandate-1',
        runId: 'run-1',
        operationId: 'op-abandon-mandate-1',
        kind: 'operator-control',
        payload: { control: 'abandon', controlId: 'abandon-mandate-1', mandate: mandateRef, predecessor: null },
      }),
    )
    const successor = workflow.featureMandate(SCOPE, {
      recordId: 'mandate-2',
      runId: 'run-2',
      operationId: 'op-mandate-2',
      branch: 'feature/bounded',
      base: 'main',
      lineageHead: null,
      body: originalBody,
      ownSpec: workflow.ownSpecFromSnapshot(SCOPE, original.snapshot),
      config: {
        version: mandated.payload.config.version,
        digest: mandated.payload.config.digest,
        effective: mandated.payload.config.effective,
      },
      antecedent: mandateRef,
    })
    const successorRef = { scope: SCOPE, recordId: successor.recordId, kind: 'mandate' as const }
    const selectedSuccessor = must(
      buildRecord({
        version: 1,
        repository: SCOPE.repository,
        target: SCOPE.target,
        recordId: 'select-mandate-2',
        runId: 'run-2',
        operationId: 'op-select-mandate-2',
        kind: 'operator-control',
        payload: {
          control: 'select-successor',
          controlId: 'select-mandate-2',
          mandate: successorRef,
          predecessor: mandateRef,
          successor: successorRef,
        },
      }),
    )
    const successorHistory = history([mandated, oldStart, oldResult, abandoned, successor, selectedSuccessor])
    const successorEvidence = await planEvidence(successorHistory, null, originalBody, [])
    expect(selectApplicableMandate(successorHistory, [], successorEvidence.causal)).toMatchObject({
      status: 'applicable',
      mandate: { recordId: successor.recordId },
    })
    expect(planMacro(successorEvidence, successor)).toMatchObject({
      phase: 'needs-draft',
      draftActionId: null,
    })
    const [antecedentOpenPlanStart] = workflow.planDraftRecords(mandated, 'act-plan-open', originalVersion)
    const antecedentUncertain = reconstructWorkflow({
      evidence: await planEvidence(
        history([mandated, antecedentOpenPlanStart, abandoned, successor, selectedSuccessor]),
        null,
        originalBody,
        [],
      ),
      facts: facts({
        productVersion: mandated.payload.config.productVersion,
        configVersion: mandated.payload.config.version,
        configDigest: mandated.payload.config.digest,
        supportedConfigVersions: [mandated.payload.config.version],
      }),
      decisions: workflowDecisions,
    })
    expect(antecedentUncertain).toMatchObject({ status: 'blocked', reason: 'action-uncertain' })

    const broken = assessFixture(
      mandated,
      'broken',
      initial,
      proposedAssessmentState(initial, { body: currentBody, content: currentContent }),
      null,
      [history([mandated])],
    )
    const blocked = planMacro(
      await planEvidence(
        history([mandated, broken.start, broken.result, newStart, newResult, newReviewStart, newReview]),
        null,
        currentBody,
        [],
      ),
      mandated,
    )
    expect(blocked.phase).toBe('blocked')
    expect(blocked.specDigest).toBeNull()
    expect(blocked.evidence.some((item) => item.code === 'incomplete')).toBe(true)
  })
})
