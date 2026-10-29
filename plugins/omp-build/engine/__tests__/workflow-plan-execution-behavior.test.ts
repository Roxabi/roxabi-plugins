import { describe, expect, test } from 'vitest'
import { acceptedActionInputs } from '../../testing/action-input-fixtures.ts'
import { criterionImplementationRecords } from '../../testing/criterion-accepted-plan.ts'
import { TEST_HEAD } from '../../testing/record-builders.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { actionInputDigest, canonicalValueDigest } from '../action-input.ts'
import type { DeliveryDataRef } from '../action-input-schema.ts'
import { selectedDeclarations } from '../criterion-decision-selection.ts'
import type { DecodedHistory } from '../history-schema.ts'
import { buildRecord } from '../record-construction.ts'
import type { CanonicalRecord } from '../record-schema.ts'
import type { Diagnostic, Scope } from '../record-values.ts'
import { resolveOwnSpecEffective } from '../spec-effective.ts'
import { resolveAcceptedSpec } from '../workflow-accepted-spec.ts'
import { selectApplicableMandate } from '../workflow-mandate-admission.ts'
import { planMacro } from '../workflow-plan-macro.ts'
import { reconstructWorkflow } from '../workflow-reconstruction-admission.ts'
import type { SpecializedDecisions } from '../workflow-reconstruction-types.ts'
import { implementationResult, implementationStart } from './workflow-implementation-support.ts'
import {
  acceptMaterialFixture,
  assessFixture,
  mandateAssessmentState,
  proposedAssessmentState,
} from './workflow-spec-assessment-support.ts'
import { BODY, binding, facts, history, must, SCOPE } from './workflow-test-support.ts'

function recordPin(record: CanonicalRecord, selector: string, value: unknown) {
  return {
    source: 'record' as const,
    record: {
      scope: { repository: record.repository, target: record.target },
      recordId: record.recordId,
      kind: record.kind,
    },
    selector,
    digest: canonicalValueDigest(value),
  }
}

function fixturePlan(records: CanonicalRecord[]) {
  const plan = records.find(
    (record) =>
      record.kind === 'action-receipt' && record.payload.action === 'plan' && record.payload.phase === 'result',
  )
  if (plan?.kind !== 'action-receipt' || plan.payload.action !== 'plan' || plan.payload.phase !== 'result')
    throw new Error('Expected a current plan')
  return { ...plan, payload: plan.payload }
}

function fixtureImplementation(records: CanonicalRecord[]) {
  const implementation = records.find(
    (record) =>
      record.kind === 'action-receipt' && record.payload.action === 'implement' && record.payload.phase === 'result',
  )
  if (
    implementation?.kind !== 'action-receipt' ||
    implementation.payload.action !== 'implement' ||
    implementation.payload.phase !== 'result' ||
    implementation.payload.structured === null
  )
    throw new Error('Expected an admitted implementation')
  return { ...implementation, payload: implementation.payload }
}

function successorFixture(classification: 'editorial' | 'material') {
  const workflow = roxabiWorkflowFixtures()
  const mandate = workflow.featureMandate(SCOPE, {
    recordId: 'mandate-editorial-owner',
    runId: 'run-editorial-owner',
    operationId: 'op-mandate-editorial-owner',
    branch: 'feature/bounded',
    base: 'main',
    lineageHead: null,
    body: BODY,
  })
  const initial = mandateAssessmentState(mandate)
  const editorial = assessFixture(
    mandate,
    'accepted-editorial',
    initial,
    proposedAssessmentState(initial, { body: 'An editorial clarification of the accepted criterion' }),
    classification,
  )
  const control =
    classification === 'material' ? acceptMaterialFixture(mandate, 'accept-material-owner', editorial) : null
  const acceptedRecords = [mandate, editorial.start, editorial.result, ...(control === null ? [] : [control])]
  const accepted = resolveAcceptedSpec(mandate, [history(acceptedRecords)])
  if (!accepted.ok) throw new Error('Spec successor must be accepted')
  expect(accepted.spec.ref.sourceAccepted.recordId).toBe(control?.recordId ?? editorial.result.recordId)
  const effective = must(resolveOwnSpecEffective(accepted.spec))
  const produced = criterionImplementationRecords(mandate, TEST_HEAD, accepted.spec)
  const plan = fixturePlan(produced)
  const implementation = fixtureImplementation(produced)
  const declaration = implementation.payload.structured?.criteria[0]
  if (declaration?.verification !== 'evidence') throw new Error('Expected captured criterion evidence')
  expect(declaration.target.spec).toEqual(accepted.spec.ref)
  expect('mandateId' in implementation.payload.exactInputs && implementation.payload.exactInputs.mandateId).toBe(
    mandate.recordId,
  )
  const pull: Scope = { repository: SCOPE.repository, target: 'acme/app#99' }
  const prBinding = binding(mandate, pull)
  const base = acceptedActionInputs(mandate, 'review')
  const deliveryData: DeliveryDataRef[] = [
    { ...recordPin(plan, '/payload/structured', plan.payload.structured), role: 'plan' },
    { ...recordPin(implementation, '/payload/structured/criteria/0', declaration), role: 'implementation' },
  ]
  const manifest = {
    ...base.manifest,
    code: { ...base.manifest.code, repository: SCOPE.repository, head: TEST_HEAD },
    subject: {
      kind: 'uw' as const,
      uw: SCOPE,
      pullRequest: pull,
      binding: recordPin(prBinding, '/payload', prBinding.payload),
    },
    spec: { kind: 'accepted' as const, effective },
    acceptedSources: [
      recordPin(mandate, '/payload', mandate.payload),
      recordPin(editorial.result, '/payload', editorial.result.payload),
      ...(control === null ? [] : [recordPin(control, '/payload', control.payload)]),
    ],
    deliveryData,
  }
  return { mandate, acceptedRecords, produced, plan, implementation, declaration, pull, prBinding, base, manifest }
}

type SuccessorFixture = ReturnType<typeof successorFixture>

function selectSuccessor(
  fixture: SuccessorFixture,
  manifest = fixture.manifest,
  histories = [history([...fixture.acceptedRecords, ...fixture.produced]), history([fixture.prBinding], fixture.pull)],
) {
  const problems: Diagnostic[] = []
  const result = selectedDeclarations(
    histories,
    { ...fixture.base, manifest, fingerprint: actionInputDigest(manifest) },
    problems,
  )
  return { result, problems }
}

function alteredAuthority(source: DecodedHistory, id: string, mode: 'foreign' | 'edited') {
  return {
    ...source,
    operations: source.operations.map((operation) => {
      if (operation.recordId !== id) return operation
      if (mode === 'foreign') return { ...operation, authority: 'foreign' as const }
      return { ...operation, parts: operation.parts.map((part) => ({ ...part, updatedAt: '2026-10-22T00:00:00Z' })) }
    }),
  }
}

function assertPinnedAuthority(fixture: SuccessorFixture) {
  const { manifest, mandate, acceptedRecords, produced, prBinding, pull } = fixture
  const noPin = {
    ...manifest,
    acceptedSources: manifest.acceptedSources.filter((pin) => pin.record.kind !== 'mandate'),
  }
  expect(selectSuccessor(fixture, noPin).result.declarations).toEqual([])
  const issue = history([...acceptedRecords, ...produced])
  const bindingHistory = history([prBinding], pull)
  for (const mode of ['foreign', 'edited'] as const) {
    expect(
      selectSuccessor(fixture, manifest, [issue, alteredAuthority(bindingHistory, prBinding.recordId, mode)]).result
        .declarations,
    ).toEqual([])
    expect(
      selectSuccessor(fixture, manifest, [alteredAuthority(issue, mandate.recordId, mode), bindingHistory]).result
        .declarations,
    ).toEqual([])
  }
}

function assertOwnerIsolation(fixture: SuccessorFixture) {
  const { implementation, plan, manifest, acceptedRecords, produced, prBinding, pull, declaration } = fixture
  const bindingHistory = history([prBinding], pull)
  const foreignPlan = {
    ...plan,
    recordId: 'plan-other-owner',
    operationId: 'op-plan-other-owner',
    payload: { ...plan.payload, mandate: { ...plan.payload.mandate, recordId: 'mandate-other-owner' } },
  }
  const competing = selectSuccessor(fixture, manifest, [
    history([...acceptedRecords, ...produced, foreignPlan]),
    bindingHistory,
  ])
  expect(competing.problems).toEqual([])
  expect(competing.result.declarations).toEqual([declaration])
  for (const owner of [
    { ...implementation.payload.mandate, recordId: 'mandate-wrong-owner' },
    { ...implementation.payload.mandate, scope: { ...implementation.payload.mandate.scope, target: 'acme/app#other' } },
  ]) {
    const other = { ...implementation, payload: { ...implementation.payload, mandate: owner } }
    const wrongHistory = history([
      ...acceptedRecords,
      ...produced.filter((record) => record.recordId !== implementation.recordId),
      other,
    ])
    const outcome = selectSuccessor(fixture, manifest, [wrongHistory, bindingHistory])
    expect(outcome.result.declarations).toEqual([])
    expect(outcome.problems.map((item) => item.code)).toContain('unconfirmed')
  }
}

describe('workflow plan execution behavior', () => {
  test.each(['editorial', 'material'] as const)(
    'keeps implementation proof owned by the mandate after an accepted %s Spec successor',
    (classification) => {
      const fixture = successorFixture(classification)
      const selected = selectSuccessor(fixture)
      expect(selected.problems).toEqual([])
      expect(selected.result.declarations).toEqual([fixture.declaration])
      expect(selected.result.evidence.map(({ value }) => value.id)).toEqual(['fixture-c1-evidence'])
      assertPinnedAuthority(fixture)
      assertOwnerIsolation(fixture)
    },
  )
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
