import { describe, expect, test } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { parseIssueSpecBody, rawSource } from '../../adapters/github-native/uw-spec.ts'
import { strictSpecBody } from '../../skills/feature/testing/epic-driver/epic-driver-records.ts'
import {
  acceptedActionInputs,
  fixtureReviewClassCatalogues,
  observeFixtureNativeWorld,
} from '../../testing/action-input-fixtures.ts'
import { criterionImplementationRecords } from '../../testing/criterion-accepted-plan.ts'
import { TEST_HEAD } from '../../testing/record-builders.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { eligiblePlan } from '../../testing/workflow-decision-cases/support/workflow-decision-fixtures.ts'
import { actionInputDigest, canonicalValueDigest } from '../action-input.ts'
import type { DeliveryDataRef } from '../action-input-schema.ts'
import { selectedDeclarations } from '../criterion-decision-selection.ts'
import type { DecodedHistory } from '../history-schema.ts'
import type { CanonicalRecord } from '../record-schema.ts'
import type { Diagnostic, Scope } from '../record-values.ts'
import { resolveSpecEffective } from '../spec-effective.ts'
import { resolveAcceptedSpec } from '../workflow-accepted-spec.ts'
import { recordsOf } from '../workflow-control.ts'
import {
  acceptMaterialFixture,
  assessFixture,
  mandateAssessmentState,
  proposedAssessmentState,
} from './workflow-spec-assessment-support.ts'
import { binding, history, must, SCOPE } from './workflow-test-support.ts'

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

async function successorFixture(classification: 'editorial' | 'material') {
  const workflow = roxabiWorkflowFixtures()
  const originalBody = strictSpecBody('Ship the bounded workflow')
  const currentBody = strictSpecBody('An editorial clarification of the accepted criterion')
  const original = parseIssueSpecBody({ uw: SCOPE, raw: rawSource(SCOPE.target, originalBody, '2026-10-21T00:00:00Z') })
  const current = parseIssueSpecBody({ uw: SCOPE, raw: rawSource(SCOPE.target, currentBody, '2026-10-21T00:00:00Z') })
  if (original.status !== 'conformant' || current.status !== 'conformant')
    throw new Error('Expected native Spec snapshots')
  const mandate = workflow.featureMandate(SCOPE, {
    recordId: 'mandate-editorial-owner',
    runId: 'run-editorial-owner',
    operationId: 'op-mandate-editorial-owner',
    branch: 'feature/bounded',
    base: 'main',
    lineageHead: null,
    body: originalBody,
    ownSpec: workflow.ownSpecFromSnapshot(SCOPE, original.snapshot),
  })
  const initial = mandateAssessmentState(mandate)
  const editorial = assessFixture(
    mandate,
    'accepted-editorial',
    initial,
    proposedAssessmentState(initial, {
      body: currentBody,
      content: {
        criteria: current.snapshot.spec.criteria,
        invariants: current.snapshot.spec.invariants,
        exclusions: current.snapshot.spec.exclusions,
        openQuestions: current.snapshot.spec.openQuestions,
        sections: current.snapshot.spec.sections,
      },
    }),
    classification,
    [history([mandate])],
  )
  const control =
    classification === 'material' ? acceptMaterialFixture(mandate, 'accept-material-owner', editorial) : null
  const acceptedRecords = [mandate, editorial.start, editorial.result, ...(control === null ? [] : [control])]
  const accepted = resolveAcceptedSpec(mandate, [history(acceptedRecords)])
  if (!accepted.ok) throw new Error('Spec successor must be accepted')
  expect(accepted.spec.ref.sourceAccepted.recordId).toBe(control?.recordId ?? editorial.result.recordId)
  const effective = must(
    resolveSpecEffective({
      mode: 'historical',
      own: accepted.spec.ref,
      versionVector: [accepted.spec.ref, ...accepted.spec.inheritedOwnSpecRefs],
      histories: [history(acceptedRecords)],
    }),
  )
  const planRecords = eligiblePlan(mandate, [history(acceptedRecords)], effective).filter(
    (record) => record.recordId !== mandate.recordId,
  )
  const before = history([...acceptedRecords, ...planRecords])
  const seed = await observeFixtureNativeWorld({
    root: SCOPE,
    nodes: [
      {
        scope: SCOPE,
        title: 'Bounded workflow',
        body: currentBody,
        updatedAt: '2026-10-21T00:00:00Z',
        labels: ['size:S'],
        parent: null,
        children: [],
        blockers: [],
        state: 'OPEN',
        stateReason: null,
      },
    ],
    histories: [before],
    pullRequests: [],
    commits: [],
    comparisons: [],
  })
  if (seed.observation.graph.status !== 'complete') throw new Error('Expected a complete native graph')
  const records = await criterionImplementationRecords({
    graph: seed.observation.graph,
    histories: [before],
    scope: SCOPE,
    mandate,
    author: 'operator',
    startHead: 'b'.repeat(40),
    head: TEST_HEAD,
    baseTip: 'b'.repeat(40),
    remoteTipBefore: 'b'.repeat(40),
    remoteTipAfter: TEST_HEAD,
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
        sha: TEST_HEAD,
        parents: ['b'.repeat(40)],
        tree: 'c'.repeat(40),
        subject: 'feat: implement bounded workflow (#42)',
        paths: ['fixture.txt'],
        config: null,
      },
    ],
    branch: 'feature/bounded',
    command: 'bun test',
    output: 'PASS',
  })
  const priorIds = new Set(recordsOf(history(acceptedRecords)).map((record) => record.recordId))
  const produced = records.filter((record) => !priorIds.has(record.recordId))
  const plan = fixturePlan(produced)
  const implementation = fixtureImplementation(produced)
  if (implementation.payload.structured?.outcome === 'missing-context')
    throw new Error('Expected implementation output')
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

type SuccessorFixture = Awaited<ReturnType<typeof successorFixture>>

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
    fixtureReviewClassCatalogues(),
  )
  return { result, problems }
}

function alteredAuthority(source: DecodedHistory, id: string, mode: 'foreign' | 'edited') {
  const operation = source.operations.find((entry) => entry.recordId === id)
  if (!operation) throw new Error(`Missing authority record ${id}`)
  const ids = new Set(operation.parts.map((part) => part.nativeId))
  return decodeHistory({
    ...source.source,
    comments: source.source.comments.map((comment) =>
      !ids.has(comment.nativeId)
        ? comment
        : mode === 'foreign'
          ? { ...comment, author: 'stranger' }
          : { ...comment, updatedAt: '2026-10-22T00:00:00Z' },
    ),
  })
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
describe('workflow plan successor ownership', () => {
  test('requires the exact authenticated historical version vector', async () => {
    const { mandate, acceptedRecords } = await successorFixture('editorial')
    const histories = [history(acceptedRecords)]
    const accepted = resolveAcceptedSpec(mandate, histories)
    if (!accepted.ok) throw new Error('Expected accepted successor')
    const own = accepted.spec.ref
    expect(resolveSpecEffective({ mode: 'historical', own, versionVector: [own], histories }).ok).toBe(true)
    expect(resolveSpecEffective({ mode: 'historical', own, versionVector: [own, own], histories }).ok).toBe(false)
    expect(
      resolveSpecEffective({ mode: 'historical', own, versionVector: [{ ...own, version: '0'.repeat(64) }], histories })
        .ok,
    ).toBe(false)
  })

  test.each(['editorial', 'material'] as const)(
    'keeps implementation proof owned by the mandate after an accepted %s Spec successor',
    async (classification) => {
      const fixture = await successorFixture(classification)
      const selected = selectSuccessor(fixture)
      expect(selected.problems).toEqual([])
      expect(selected.result.declarations).toEqual([fixture.declaration])
      expect(selected.result.evidence.map(({ value }) => value.id)).toEqual(['native-fixture-criterion'])
      assertPinnedAuthority(fixture)
      assertOwnerIsolation(fixture)
    },
  )
})
