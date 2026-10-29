import { describe, expect, test } from 'vitest'
import { acceptedActionInputs } from '../../testing/action-input-fixtures.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { buildRecord } from '../record-construction.ts'
import { failedCheckEvidenceDigest } from '../record-digests.ts'
import type { Scope } from '../record-values.ts'
import { ACTION_RECEIPT_FORMAT } from '../workflow-receipt-schema.ts'
import { reconstructWorkflow } from '../workflow-reconstruction-admission.ts'
import type { SpecializedDecisions } from '../workflow-reconstruction-types.ts'
import { implementationResult, implementationStart } from './workflow-implementation-support.ts'
import { binding, facts, history, must, SCOPE } from './workflow-test-support.ts'

describe('workflow implementation behavior', () => {
  test('does not let an open or rejected implementation bypass confirmation because a pull request exists', () => {
    const workflow = roxabiWorkflowFixtures()
    const { featureMandate: shippedFeatureMandate } = workflow
    const shipped = shippedFeatureMandate(SCOPE, {
      recordId: 'mandate-1',
      runId: 'run-1',
      operationId: 'op-mandate-1',
      branch: 'feature/bounded',
      base: 'main',
      lineageHead: null,
      body: 'ship the bounded workflow',
    })
    if (shipped.kind !== 'mandate') throw new Error('expected a mandate')
    const pull: Scope = { repository: 'acme/app', target: 'acme/app#99' }
    const start = implementationStart(shipped, 'act-implement', 'plan-missing')
    const rejected = implementationResult(shipped, start, 'act-implement', 'plan-missing', false)
    const decisions: SpecializedDecisions = {
      reviewStep: null,
      epicStep: null,
      epicLand: null,
      ciWatchStatus: null,
      publish: { status: 'absent', evidence: [] },
      landing: { status: 'absent', evidence: [] },
      watch: { status: 'absent', evidence: [] },
    }
    const shippedFacts = facts({
      productVersion: shipped.payload.config.productVersion,
      configVersion: shipped.payload.config.version,
      configDigest: shipped.payload.config.digest,
      supportedConfigVersions: [shipped.payload.config.version],
      pullRequest: { scope: pull, head: 'feature/bounded', base: 'main', associatedIssue: SCOPE },
    })
    const bound = history([binding(shipped, pull)], pull)
    const open = reconstructWorkflow({
      evidence: { issue: history([shipped, start]), pullRequest: bound, parents: [] },
      facts: shippedFacts,
      decisions,
    })
    expect(open).toMatchObject({ status: 'blocked', reason: 'action-uncertain' })
    const rejectedDecision = reconstructWorkflow({
      evidence: { issue: history([shipped, start, rejected]), pullRequest: bound, parents: [] },
      facts: shippedFacts,
      decisions,
    })
    expect(rejectedDecision).toMatchObject({ status: 'blocked', reason: 'unconfirmed' })
    const [planStart, planResult] = workflow.planDraftRecords(shipped)
    const planReviewStart = workflow.planReviewStart(shipped, 'act-plan-1', workflow.publishedPlanDigest())
    const planReview = workflow.planReviewRecord(shipped, 'act-plan-1', workflow.publishedPlanDigest(), [
      workflow.clearPlanContribution('slot-architect', 'R-workflow-plan-architect'),
      workflow.clearPlanContribution('slot-adversarial', 'R-workflow-plan-adversarial'),
    ])
    const admittedStart = implementationStart(shipped, 'act-implement-admitted', 'act-plan-1')
    const admittedResult = implementationResult(shipped, admittedStart, 'act-implement-admitted', 'act-plan-1', true)
    const adopted = reconstructWorkflow({
      evidence: {
        issue: history([shipped, planStart, planResult, planReviewStart, planReview, admittedStart, admittedResult]),
        pullRequest: bound,
        parents: [],
      },
      facts: shippedFacts,
      decisions: { ...decisions, publish: { status: 'published', evidence: [] } },
    })
    expect(adopted).toMatchObject({ status: 'action', action: 'review' })
    expect(history([shipped]).operations.some((operation) => operation.record?.kind === 'action-receipt')).toBe(false)
    const nativeOnly = reconstructWorkflow({
      evidence: { issue: history([shipped]), pullRequest: history([], pull), parents: [] },
      facts: shippedFacts,
      decisions,
    })
    expect(nativeOnly).toMatchObject({ status: 'action', action: 'plan' })
    expect(nativeOnly).not.toMatchObject({ status: 'action', action: 'review' })
  })

  test('does not dispatch implementation when a pinned graph reaches it without a confirmed plan', () => {
    const workflow = roxabiWorkflowFixtures()
    const baseline = workflow.featureMandate(SCOPE, { body: 'ship the bounded workflow' })
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
      body: 'ship the bounded workflow',
      config: {
        version: baseline.payload.config.version,
        digest: baseline.payload.config.digest,
        effective: { graph },
      },
    })
    const decision = reconstructWorkflow({
      evidence: { issue: history([mandated]), pullRequest: null, parents: [] },
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
  test('retains an unmatched CI attribution when the current candidate changes', () => {
    const { featureMandate: shippedFeatureMandate } = roxabiWorkflowFixtures()
    const shipped = shippedFeatureMandate(SCOPE, {
      recordId: 'mandate-1',
      runId: 'run-1',
      operationId: 'op-mandate-1',
      branch: 'feature/bounded',
      base: 'main',
      lineageHead: null,
      body: 'ship the bounded workflow',
    })
    if (shipped.kind !== 'mandate') throw new Error('expected a mandate')
    const pull: Scope = { repository: SCOPE.repository, target: 'acme/app#99' }
    const oldCandidate = 'a'.repeat(40)
    const currentCandidate = 'b'.repeat(40)
    const oldFailure = {
      name: 'old-check',
      source: 'check-run',
      observationId: 'old-observation',
      conclusion: 'failure',
    }
    const currentFailure = {
      name: 'current-check',
      source: 'check-run',
      observationId: 'current-observation',
      conclusion: 'failure',
    }
    const oldDigest = failedCheckEvidenceDigest({
      candidateGitSHA: oldCandidate,
      scope: pull,
      failures: [oldFailure],
    })
    const currentDigest = failedCheckEvidenceDigest({
      candidateGitSHA: currentCandidate,
      scope: pull,
      failures: [currentFailure],
    })
    if (oldDigest === null || currentDigest === null) throw new Error('expected CI evidence digests')
    const staleStart = must(
      buildRecord({
        version: 1,
        repository: SCOPE.repository,
        target: SCOPE.target,
        recordId: 'attribute-ci-old-start',
        runId: 'run-1',
        operationId: 'op-attribute-ci-old-start',
        kind: 'action-receipt',
        payload: {
          format: ACTION_RECEIPT_FORMAT,
          inputs: acceptedActionInputs(shipped, 'attribute-ci'),
          phase: 'start',
          action: 'attribute-ci',
          actionId: 'act-attribute-ci-old',
          mandate: { scope: SCOPE, recordId: shipped.recordId, kind: 'mandate' },
          exactInputs: {
            candidateGitSHA: oldCandidate,
            scope: pull,
            failedChecks: [oldFailure.name],
            evidenceDigest: oldDigest,
            failures: [oldFailure],
          },
        },
      }),
    )
    const decision = reconstructWorkflow({
      evidence: {
        issue: history([shipped, staleStart]),
        pullRequest: history([binding(shipped, pull)], pull),
        parents: [],
      },
      facts: facts({
        candidateGitSHA: currentCandidate,
        productVersion: shipped.payload.config.productVersion,
        configVersion: shipped.payload.config.version,
        configDigest: shipped.payload.config.digest,
        supportedConfigVersions: [shipped.payload.config.version],
        pullRequest: { scope: pull, head: currentCandidate, base: 'main', associatedIssue: SCOPE },
        failedChecks: [currentFailure.name],
        evidenceDigest: currentDigest,
      }),
      decisions: {
        reviewStep: 'fix',
        epicStep: null,
        epicLand: null,
        ciWatchStatus: 'red',
        publish: { status: 'absent', evidence: [] },
        landing: { status: 'absent', evidence: [] },
        watch: { status: 'absent', evidence: [] },
      },
    })
    expect(decision).toMatchObject({ status: 'blocked', reason: 'action-uncertain' })
    const greenDecision = reconstructWorkflow({
      evidence: {
        issue: history([shipped, staleStart]),
        pullRequest: history([binding(shipped, pull)], pull),
        parents: [],
      },
      facts: facts({
        candidateGitSHA: currentCandidate,
        productVersion: shipped.payload.config.productVersion,
        configVersion: shipped.payload.config.version,
        configDigest: shipped.payload.config.digest,
        supportedConfigVersions: [shipped.payload.config.version],
        pullRequest: { scope: pull, head: currentCandidate, base: 'main', associatedIssue: SCOPE },
        failedChecks: [],
        evidenceDigest: null,
      }),
      decisions: {
        reviewStep: null,
        epicStep: null,
        epicLand: null,
        ciWatchStatus: 'green',
        publish: { status: 'absent', evidence: [] },
        landing: { status: 'absent', evidence: [] },
        watch: { status: 'absent', evidence: [] },
      },
    })
    expect(greenDecision).toMatchObject({ status: 'blocked', reason: 'action-uncertain' })
  })
})
