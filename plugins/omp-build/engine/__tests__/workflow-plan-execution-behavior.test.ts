import { describe, expect, test } from 'vitest'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { buildRecord, parseRecord } from '../record-construction.ts'
import type { Scope } from '../record-values.ts'
import { selectApplicableMandate } from '../workflow-mandate-admission.ts'
import { planDigest } from '../workflow-output-schema.ts'
import { planMacro } from '../workflow-plan-macro.ts'
import { reconstructWorkflow } from '../workflow-reconstruction-admission.ts'
import type { SpecializedDecisions } from '../workflow-reconstruction-types.ts'
import { implementationResult, implementationStart } from './workflow-implementation-support.ts'
import { assessFixture } from './workflow-spec-assessment-support.ts'
import { BODY, binding, facts, history, must, SCOPE } from './workflow-test-support.ts'

describe('workflow plan execution behavior', () => {
  test('binds planMacro to the accepted Spec after editorial advancement', () => {
    const { featureMandate: shippedFeatureMandate, fixOnlyMandate: shippedFixOnlyMandate } = roxabiWorkflowFixtures()
    const mandated = shippedFeatureMandate(SCOPE, {
      recordId: 'mandate-1',
      runId: 'run-1',
      operationId: 'op-mandate-1',
      branch: 'feature/bounded',
      base: 'main',
      lineageHead: null,
      body: BODY,
      proofPins: [],
    })
    if (mandated.kind !== 'mandate') throw new Error('expected a mandate')
    const originalDigest = mandated.payload.spec.bodySha256
    const advancedBody = 'editorial body'
    const editorial = assessFixture(mandated, 'edit', BODY, advancedBody, 'editorial')
    const advancedDigest = editorial.currentDigest
    expect(advancedDigest).not.toBe(originalDigest)
    const planOutput = {
      steps: [
        {
          id: 'step-1',
          change: 'bind the accepted Spec',
          doneWhen: 'the plan matches Spec B',
          criterion: 'exactInputs.specDigest is the accepted digest',
          evidence: 'planMacro.specDigest',
          paths: ['plugins/omp-build/engine/workflow-plan-macro.ts'],
        },
      ],
      resolutions: [],
    }
    const digest = planDigest(planOutput)
    const mandateRef = { scope: SCOPE, recordId: mandated.recordId, kind: 'mandate' as const }
    const slots = [
      { slotId: 'slot-architect', specialist: 'R-workflow-plan-architect' as const },
      { slotId: 'slot-adversarial', specialist: 'R-workflow-plan-adversarial' as const },
    ]
    const contribution = (slotId: string, specialist: string) => ({
      content: 'findings' as const,
      inventoryId: null,
      host: { origin: 'native' as const, phase: null, role: specialist, slotId, chunk: 0, childId: slotId },
      rawAttempts: [],
      native: { completion: 'completed' as const, strict: 'valid' as const, raw: null },
      structured: { outcome: 'clear', blockers: [] },
      findings: null,
    })
    const planPair = (actionId: string, specSha: string) => {
      const start = must(
        buildRecord({
          version: 1,
          repository: SCOPE.repository,
          target: SCOPE.target,
          recordId: `${actionId}-start`,
          runId: 'run-1',
          operationId: `op-${actionId}-start`,
          kind: 'action-receipt',
          payload: {
            phase: 'start',
            action: 'plan',
            actionId,
            mandate: mandateRef,
            exactInputs: {
              mandateId: mandated.recordId,
              specDigest: specSha,
              amendsReviewActionId: null,
              requiredBlockers: [],
            },
          },
        }),
      )
      const result = must(
        buildRecord({
          version: 1,
          repository: SCOPE.repository,
          target: SCOPE.target,
          recordId: `${actionId}-result`,
          runId: 'run-1',
          operationId: `op-${actionId}-result`,
          kind: 'action-receipt',
          payload: {
            phase: 'result',
            action: 'plan',
            actionId,
            mandate: mandateRef,
            start: { scope: SCOPE, recordId: start.recordId, kind: 'action-receipt' },
            exactInputs: {
              mandateId: mandated.recordId,
              specDigest: specSha,
              amendsReviewActionId: null,
              requiredBlockers: [],
            },
            native: { completion: 'completed', strict: 'valid', raw: null },
            structured: planOutput,
            admission: null,
            diagnostics: [],
          },
        }),
      )
      return [start, result] as const
    }
    const reviewPair = (actionId: string, draftActionId: string, specSha: string) => {
      const start = must(
        buildRecord({
          version: 1,
          repository: SCOPE.repository,
          target: SCOPE.target,
          recordId: `${actionId}-start`,
          runId: 'run-1',
          operationId: `op-${actionId}-start`,
          kind: 'action-receipt',
          payload: {
            phase: 'start',
            action: 'plan-review',
            actionId,
            mandate: mandateRef,
            exactInputs: {
              mandateId: mandated.recordId,
              specDigest: specSha,
              planDigest: digest,
              draftActionId,
            },
            slots,
          },
        }),
      )
      const result = must(
        buildRecord({
          version: 1,
          repository: SCOPE.repository,
          target: SCOPE.target,
          recordId: `${actionId}-result`,
          runId: 'run-1',
          operationId: `op-${actionId}-result`,
          kind: 'action-receipt',
          payload: {
            phase: 'result',
            action: 'plan-review',
            actionId,
            mandate: mandateRef,
            start: { scope: SCOPE, recordId: start.recordId, kind: 'action-receipt' },
            exactInputs: {
              mandateId: mandated.recordId,
              specDigest: specSha,
              planDigest: digest,
              draftActionId,
            },
            slots,
            contributions: [
              contribution('slot-architect', 'R-workflow-plan-architect'),
              contribution('slot-adversarial', 'R-workflow-plan-adversarial'),
            ],
            native: { completion: 'completed', strict: 'valid', raw: null },
            structured: null,
            admission: null,
            diagnostics: [],
          },
        }),
      )
      return [start, result] as const
    }
    const [oldStart, oldResult] = planPair('act-plan-a', originalDigest)
    const [oldReviewStart, oldReview] = reviewPair('act-plan-review-a', 'act-plan-a', originalDigest)
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
      specDigest: advancedDigest,
    })
    expect(stale.phase).not.toBe('eligible')

    const [newStart, newResult] = planPair('act-plan-b', advancedDigest)
    const [newReviewStart, newReview] = reviewPair('act-plan-review-b', 'act-plan-b', advancedDigest)
    const bound = planMacro(
      {
        issue: history([
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
        ]),
        pullRequest: null,
        parents: [],
      },
      mandated,
    )
    expect(bound).toMatchObject({
      phase: 'eligible',
      specDigest: advancedDigest,
      draftActionId: 'act-plan-b',
      reviewActionId: 'act-plan-review-b',
    })
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
    const workflowFacts = facts({
      productVersion: mandated.payload.config.productVersion,
      specDigest: advancedDigest,
      specBody: advancedBody,
      configVersion: mandated.payload.config.version,
      configDigest: mandated.payload.config.digest,
      supportedConfigVersions: [mandated.payload.config.version],
      proofPins: mandated.payload.proofPins,
    })
    const workflowDecisions: SpecializedDecisions = {
      reviewStep: null,
      epicStep: null,
      epicLand: null,
      ciWatchStatus: null,
      publish: { status: 'absent', evidence: [] },
      landing: { status: 'absent', evidence: [] },
      watch: { status: 'absent', evidence: [] },
      proof: { admission: null, candidateGitSHA: null, input: null, applicability: 'required', evidence: [] },
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

    const currentImplementationResult = implementationResult(
      mandated,
      currentImplementationStart,
      'act-implement-b',
      'act-plan-b',
      true,
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
    const proof = reconstructWorkflow({
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
        pullRequest: { scope: pull, head: 'abc', base: 'main', associatedIssue: SCOPE },
      },
      decisions: workflowDecisions,
    })
    expect(proof).toMatchObject({ status: 'action', action: 'proof' })

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
    const successorBase = shippedFixOnlyMandate(SCOPE, {
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
      proofPins: [],
      parent: null,
      antecedent: mandateRef,
    })
    const successor = must(
      parseRecord({
        ...successorBase,
        payload: {
          ...successorBase.payload,
          role: 'feature',
          permissions: { landing: true, correct: true },
        },
      }),
    )
    if (successor.kind !== 'mandate') throw new Error('expected a mandate')
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
    const antecedentOpenPlanStart = must(
      buildRecord({
        version: 1,
        repository: SCOPE.repository,
        target: SCOPE.target,
        recordId: 'act-plan-open-start',
        runId: 'run-1',
        operationId: 'op-act-plan-open-start',
        kind: 'action-receipt',
        payload: {
          phase: 'start',
          action: 'plan',
          actionId: 'act-plan-open',
          mandate: mandateRef,
          exactInputs: {
            mandateId: mandated.recordId,
            specDigest: originalDigest,
            amendsReviewActionId: null,
            requiredBlockers: [],
          },
        },
      }),
    )
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
        proofPins: mandated.payload.proofPins,
      }),
      decisions: workflowDecisions,
    })
    expect(antecedentUncertain).toMatchObject({ status: 'blocked', reason: 'action-uncertain' })

    const malformed = assessFixture(mandated, 'broken', BODY, advancedBody, null)
    const blocked = planMacro(
      {
        issue: history([mandated, malformed.start, malformed.result, newStart, newResult, newReviewStart, newReview]),
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
