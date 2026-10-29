import { describe, expect, test } from 'vitest'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { buildRecord } from '../record-construction.ts'
import type { Scope } from '../record-values.ts'
import { resolveAcceptedSpec } from '../workflow-accepted-spec.ts'
import { selectApplicableMandate } from '../workflow-mandate-admission.ts'
import { planMacro } from '../workflow-plan-macro.ts'
import { reconstructWorkflow } from '../workflow-reconstruction-admission.ts'
import type { SpecializedDecisions } from '../workflow-reconstruction-types.ts'
import { implementationResult, implementationStart } from './workflow-implementation-support.ts'
import { assessFixture, mandateAssessmentState, proposedAssessmentState } from './workflow-spec-assessment-support.ts'
import { BODY, binding, facts, history, must, SCOPE } from './workflow-test-support.ts'

describe('workflow plan execution behavior', () => {
  test('binds plan receipts and implementation to the accepted canonical Spec version after editorial advancement', () => {
    const workflow = roxabiWorkflowFixtures()
    const mandated = workflow.featureMandate(SCOPE, {
      recordId: 'mandate-1',
      runId: 'run-1',
      operationId: 'op-mandate-1',
      branch: 'feature/bounded',
      base: 'main',
      lineageHead: null,
      body: BODY,
    })
    const initial = mandateAssessmentState(mandated)
    const originalVersion = initial.ref.version
    const editorial = assessFixture(
      mandated,
      'edit',
      initial,
      proposedAssessmentState(initial, { body: 'editorial body' }),
      'editorial',
    )
    const advancedVersion = editorial.currentVersion
    expect(advancedVersion).not.toBe(originalVersion)
    const digest = workflow.publishedPlanDigest()

    const [oldStart, oldResult] = workflow.planDraftRecords(mandated, 'act-plan-a', originalVersion)
    const oldReviewStart = workflow.planReviewStart(
      mandated,
      'act-plan-a',
      digest,
      'act-plan-review-a',
      originalVersion,
    )
    const oldReview = workflow.planReviewRecord(
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
    const advanced = history([
      mandated,
      editorial.start,
      editorial.result,
      oldStart,
      oldResult,
      oldReviewStart,
      oldReview,
    ])
    const stale = planMacro({ issue: advanced, pullRequest: null, parents: [] }, mandated)
    expect(stale).toMatchObject({
      phase: 'needs-draft',
      specDigest: advancedVersion,
    })
    expect(stale.phase).not.toBe('eligible')

    const [newStart, newResult] = workflow.planDraftRecords(mandated, 'act-plan-b', advancedVersion)
    const newReviewStart = workflow.planReviewStart(
      mandated,
      'act-plan-b',
      digest,
      'act-plan-review-b',
      advancedVersion,
    )
    const newReview = workflow.planReviewRecord(
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
      mandated,
      editorial.start,
      editorial.result,
      oldStart,
      oldResult,
      oldReviewStart,
      oldReview,
      newStart,
      newResult,
      newReviewStart,
      newReview,
    ]
    const bound = planMacro(
      {
        issue: history(eligibleRecords),
        pullRequest: null,
        parents: [],
      },
      mandated,
    )
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
    const oldImplementationStart = implementationStart(mandated, 'act-implement-a', 'act-plan-a')
    const oldImplementationResult = implementationResult(
      mandated,
      oldImplementationStart,
      'act-implement-a',
      'act-plan-a',
      true,
    )
    const currentImplementation = reconstructWorkflow({
      evidence: {
        issue: history([...eligibleRecords, oldImplementationStart, oldImplementationResult]),
        pullRequest: null,
        parents: [],
      },
      facts: workflowFacts,
      decisions: workflowDecisions,
    })
    expect(currentImplementation).toMatchObject({ status: 'action', action: 'implement' })

    const unmatchedOldStart = implementationStart(mandated, 'act-implement-open', 'act-plan-a')
    const oldUncertain = reconstructWorkflow({
      evidence: {
        issue: history([
          mandated,
          editorial.start,
          editorial.result,
          oldStart,
          oldResult,
          oldReviewStart,
          oldReview,
          unmatchedOldStart,
        ]),
        pullRequest: null,
        parents: [],
      },
      facts: workflowFacts,
      decisions: workflowDecisions,
    })
    expect(oldUncertain).toMatchObject({ status: 'blocked', reason: 'action-uncertain' })

    const currentImplementationStart = implementationStart(mandated, 'act-implement-b', 'act-plan-b')
    const currentUncertain = reconstructWorkflow({
      evidence: {
        issue: history([
          ...eligibleRecords,
          oldImplementationStart,
          oldImplementationResult,
          currentImplementationStart,
        ]),
        pullRequest: null,
        parents: [],
      },
      facts: workflowFacts,
      decisions: workflowDecisions,
    })
    expect(currentUncertain).toMatchObject({ status: 'blocked', reason: 'action-uncertain' })

    const accepted = resolveAcceptedSpec(mandated, [history(eligibleRecords)])
    if (!accepted.ok) throw new Error('expected the advanced Spec to be accepted')
    const currentImplementationResult = implementationResult(
      mandated,
      currentImplementationStart,
      'act-implement-b',
      'act-plan-b',
      true,
      accepted.spec,
    )
    const published = reconstructWorkflow({
      evidence: {
        issue: history([
          ...eligibleRecords,
          oldImplementationStart,
          oldImplementationResult,
          currentImplementationStart,
          currentImplementationResult,
        ]),
        pullRequest: null,
        parents: [],
      },
      facts: workflowFacts,
      decisions: workflowDecisions,
    })
    expect(published).toMatchObject({ status: 'action', action: 'publish' })
    const pull: Scope = { repository: SCOPE.repository, target: 'acme/app#99' }
    const boundPull = history([binding(mandated, pull)], pull)
    const review = reconstructWorkflow({
      evidence: {
        issue: history([
          ...eligibleRecords,
          oldImplementationStart,
          oldImplementationResult,
          currentImplementationStart,
          currentImplementationResult,
        ]),
        pullRequest: boundPull,
        parents: [],
      },
      facts: {
        ...workflowFacts,
        pullRequest: { scope: pull, head: 'feature/bounded', base: 'main', associatedIssue: SCOPE },
      },
      decisions: { ...workflowDecisions, publish: { status: 'published', evidence: [] } },
    })
    expect(review).toMatchObject({ status: 'action', action: 'review' })

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
      body: BODY,
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
    expect(selectApplicableMandate(successorHistory)).toMatchObject({
      status: 'applicable',
      mandate: { recordId: successor.recordId },
    })
    expect(planMacro({ issue: successorHistory, pullRequest: null, parents: [] }, successor)).toMatchObject({
      phase: 'needs-draft',
      draftActionId: null,
    })
    const [antecedentOpenPlanStart] = workflow.planDraftRecords(mandated, 'act-plan-open', originalVersion)
    const antecedentUncertain = reconstructWorkflow({
      evidence: {
        issue: history([mandated, antecedentOpenPlanStart, abandoned, successor, selectedSuccessor]),
        pullRequest: null,
        parents: [],
      },
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
      proposedAssessmentState(initial, { body: 'editorial body' }),
      null,
    )
    const blocked = planMacro(
      {
        issue: history([mandated, broken.start, broken.result, newStart, newResult, newReviewStart, newReview]),
        pullRequest: null,
        parents: [],
      },
      mandated,
    )
    expect(blocked.phase).toBe('blocked')
    expect(blocked.specDigest).toBeNull()
    expect(blocked.evidence.some((item) => item.code === 'incomplete')).toBe(true)
  })
})
