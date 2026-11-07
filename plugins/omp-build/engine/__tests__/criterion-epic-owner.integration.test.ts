import { describe, expect, test } from 'vitest'
import { sourceRef } from '../../roxabi/uw-action-observe.ts'
import { fixtureReviewClassCatalogues } from '../../testing/action-input-fixtures.ts'
import { encodeCriterionRecords } from '../../testing/criterion-approval.ts'
import { criterionEpicReviewGraph } from '../../testing/criterion-range-approval.ts'
import { nativeImplementationGit } from '../../testing/native-implementation-git.ts'
import { produceParentIntegration } from '../../testing/parent-integration-producer.ts'
import { reviewRoot } from '../../testing/record-builders.ts'
import { actionInputDigest, canonicalValueDigest } from '../action-input.ts'
import type { ActionInputs } from '../action-input-schema.ts'
import { selectedDeclarations } from '../criterion-decision-selection.ts'
import { validateProspectiveRecord } from '../history-graph.ts'
import type { DecodedHistory } from '../history-schema.ts'
import type { Diagnostic } from '../record-values.ts'
import { reviewCandidateCode } from '../review-inventory-input.ts'
import { bindExternalRef, mandateScope, recordsOf } from '../workflow-control.ts'
import { threeDeliveredChildren } from './uw-delivery-proof-fixture.ts'
import { history } from './workflow-test-support.ts'

async function epicFixture() {
  const checkout = nativeImplementationGit()
  try {
    const [firstMerge, secondMerge, thirdMerge] = checkout.merges
    if (firstMerge === undefined || secondMerge === undefined || thirdMerge === undefined)
      throw new Error('Expected three child merges')
    await checkout.publishBase(thirdMerge)
    const parentCheckout = await checkout.parent({ repository: 'acme/app', target: 'acme/app#200' })
    return await threeDeliveredChildren(
      {
        ...checkout,
        cwd: parentCheckout.cwd,
        trees: checkout.heads.map(checkout.tree),
        baseTrees: [checkout.p0, firstMerge, secondMerge].map(checkout.tree),
        mergeTrees: checkout.merges.map(checkout.tree),
        parentTree: checkout.tree(checkout.parentHead),
        diff: checkout.diff(thirdMerge, checkout.parentHead),
      },
      [{ id: 'C1', statement: 'Save keeps the selected region' }],
      'planned',
      async (world) => {
        const base = world.merges[2]
        if (base === undefined) throw new Error('Expected third child merge')
        const produced = await produceParentIntegration(world, parentCheckout, {
          initial: parentCheckout.observe(),
          candidate: parentCheckout.observe(),
          command: 'bun test parent.test.ts',
          output: 'PASS parent integration',
        })
        const { beforeReview, completions, code } = produced
        function integrationHistory() {
          const parentHistory = beforeReview.histories.find(
            (entry) => entry.source.scope.target === world.parentScope.target,
          )
          if (!parentHistory) throw new Error('Expected parent history')
          const integrated = recordsOf(parentHistory).find((entry) => entry.recordId === produced.integrationRecordId)
          if (
            integrated?.kind !== 'action-receipt' ||
            integrated.payload.action !== 'integrate' ||
            integrated.payload.phase !== 'result'
          )
            throw new Error('Expected integration result')
          return { parentHistory, integrated }
        }
        const { parentHistory, integrated } = integrationHistory()
        const prepared = await world.operations.prepareAction({
          actionId: 'owner-review',
          purpose: 'review',
          subject: integrated.payload.inputs.manifest.subject,
          code: { ...code, referenceCommit: code.head },
          stageSources: [],
          expandedContext: [],
        })
        if (!prepared.ok) throw new Error(`Cannot prepare review: ${JSON.stringify(prepared.diagnostics)}`)
        const inputs = prepared.value.inputs
        const pin = inputs.manifest.acceptedSources.find((item) => item.record.recordId === world.parent.recordId)
        if (!pin || beforeReview.accepted.status !== 'accepted' || !beforeReview.accepted.value.coverage)
          throw new Error('Expected accepted parent owner and coverage')
        const assignment = beforeReview.accepted.value.coverage.assignments[0]
        if (!assignment) throw new Error('Expected parent criterion assignment')
        const metadata = {
          source: 'record' as const,
          record: { scope: world.parentScope, kind: 'mandate' as const, recordId: world.parent.recordId },
          selector: '/payload/coverage/assignments/0',
          digest: canonicalValueDigest(assignment),
        }
        const childRefs = completions.map((item) => {
          const firstSource = item.sources[0]
          if (firstSource === undefined) throw new Error('Missing child source')
          const source = sourceRef(beforeReview.observation.histories, firstSource)
          if (!source.ok) throw new Error('Missing child source')
          return source.value
        })
        const mandate = world.parent
        const graph = criterionEpicReviewGraph({
          mandate,
          inputs,
          head: code.head,
          range: `${code.base}..${code.head}`,
          issueRecords: recordsOf(parentHistory),
          coverageReferences: [metadata, ...childRefs],
        })
        const external = beforeReview.observation.histories.filter(
          (entry) =>
            entry.source.scope.repository !== world.parentScope.repository ||
            entry.source.scope.target !== world.parentScope.target,
        )
        const observed = encodeCriterionRecords(
          graph.records,
          world.parentScope,
          { catalogues: beforeReview.catalogues, acceptedPolicy: null },
          'operator',
          external,
          parentHistory,
        ).history
        if (graph.decision.payload.judgment.purpose !== 'review') throw new Error('Expected epic review')
        return { mandate, pin, graph, observed, external, judgment: graph.decision.payload.judgment }
      },
    )
  } finally {
    checkout.cleanup()
  }
}

function selection(inputs: ActionInputs, observed: DecodedHistory, external: readonly DecodedHistory[]) {
  const diagnostics: Diagnostic[] = []
  const selected = selectedDeclarations([observed, ...external], inputs, diagnostics, fixtureReviewClassCatalogues())
  return { selected, diagnostics }
}

describe('epic review owner admission', () => {
  test('admits current criterion evidence for an authenticated UW-range review', async () => {
    const fixture = await epicFixture()
    const { selected, diagnostics } = selection(fixture.graph.inputs, fixture.observed, fixture.external)
    expect(validateProspectiveRecord(fixture.graph.root, history([], mandateScope(fixture.mandate)))).toEqual([])
    expect(diagnostics).toEqual([])
    expect(selected.declarations).toHaveLength(1)
    expect(selected.evidence).toHaveLength(1)
    for (const record of [fixture.graph.root, fixture.graph.spec, fixture.graph.panel]) {
      const bound = bindExternalRef(
        { scope: mandateScope(fixture.mandate), kind: record.kind, recordId: record.recordId },
        fixture.observed,
      )
      expect(bound, JSON.stringify(bound)).toMatchObject({ ok: true })
    }
    expect(reviewCandidateCode(fixture.judgment, fixture.observed)).toEqual({
      repository: fixture.mandate.repository,
      commit: fixture.graph.inputs.manifest.code.head,
    })
    const pull = {
      ...fixture.observed,
      source: {
        ...fixture.observed.source,
        scope: { repository: fixture.mandate.repository, target: 'acme/widgets#99' },
      },
    }
    expect(reviewCandidateCode(fixture.judgment, pull)).toBeNull()
  })

  test('refuses a PR inventory or wrong range even when its history shares the UW scope', async () => {
    const fixture = await epicFixture()
    const { graph, mandate, judgment } = fixture
    const rootFor = (subject: { kind: 'pull-request' } | { kind: 'epic-range'; range: string }) =>
      reviewRoot({
        id: graph.root.recordId,
        scope: mandateScope(mandate),
        head: graph.inputs.manifest.code.head,
        inputSnapshot: graph.inputs,
        subject,
      })
    for (const root of [
      rootFor({ kind: 'pull-request' }),
      rootFor({ kind: 'epic-range', range: `${'f'.repeat(40)}..${graph.inputs.manifest.code.head}` }),
    ]) {
      const records = graph.records.map((record) => (record.recordId === root.recordId ? root : record))
      expect(validateProspectiveRecord(root, history([], mandateScope(mandate))).map((item) => item.code)).toContain(
        'unbound',
      )
      const observed = history([...graph.issueRecords, ...records], mandateScope(mandate))
      expect(reviewCandidateCode(judgment, observed)).toBeNull()
    }
  })

  test('refuses missing, duplicate, foreign-scope, or mismatched mandate pins', async () => {
    const fixture = await epicFixture()
    const { inputs } = fixture.graph
    const manifests = [
      { ...inputs.manifest, acceptedSources: [] },
      { ...inputs.manifest, acceptedSources: [fixture.pin, fixture.pin] },
      {
        ...inputs.manifest,
        acceptedSources: [
          {
            ...fixture.pin,
            record: { ...fixture.pin.record, scope: { ...fixture.pin.record.scope, target: 'acme/widgets#other' } },
          },
        ],
      },
      { ...inputs.manifest, acceptedSources: [{ ...fixture.pin, digest: 'a'.repeat(64) }] },
      {
        ...inputs.manifest,
        acceptedSources: [{ ...fixture.pin, record: { ...fixture.pin.record, recordId: 'wrong-owner' } }],
      },
    ]
    for (const manifest of manifests) {
      const changed = { ...inputs, manifest, fingerprint: actionInputDigest(manifest) }
      expect(selection(changed, fixture.observed, fixture.external).selected.declarations).toEqual([])
    }
  })

  test('refuses a foreign or edited native mandate', async () => {
    const fixture = await epicFixture()
    for (const mode of ['foreign', 'edited'] as const) {
      const observed = {
        ...fixture.observed,
        operations: fixture.observed.operations.map((operation) => {
          if (operation.recordId !== fixture.mandate.recordId) return operation
          if (mode === 'foreign') return { ...operation, authority: 'foreign' as const }
          return {
            ...operation,
            parts: operation.parts.map((part) => ({ ...part, updatedAt: '2026-10-22T00:00:00Z' })),
          }
        }),
      }
      expect(selection(fixture.graph.inputs, observed, fixture.external).selected.declarations).toEqual([])
    }
  })
})
