import { expect, test } from 'vitest'
import { fixtureReviewClassCatalogues } from '../../testing/action-input-fixtures.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { observedUwWithoutPullRequests } from '../../testing/uw-completion-observation.ts'
import { canonicalValueDigest } from '../action-input.ts'
import { specDigest } from '../record-digests.ts'
import { specReportSchema } from '../record-values.ts'
import { assessUwCompletion } from '../uw-completion.ts'
import { projectUwDelivery } from '../uw-delivery-projection.ts'
import { scopeKey } from '../uw-graph.ts'
import { deliveredLeaf } from './uw-delivery-proof-fixture.ts'

test('does not project criterion proof or completion for an accepted leaf without a PR', async () => {
  const uw = { repository: 'org/repo', target: 'org/repo#1' }
  const date = '2026-10-27T12:00:00.000Z'
  const fixtures = roxabiWorkflowFixtures()
  const body = '## Acceptance\n- [ ] Save keeps the selected region'
  const mandate = fixtures.featureMandate(uw, { body })
  const observation = await observedUwWithoutPullRequests({
    graph: {
      status: 'complete',
      root: uw,
      observedAt: date,
      nodes: [
        {
          uw,
          title: 'Leaf',
          raw: { reference: uw.target, body, bodySha256: specDigest(body), lastEditedAt: date },
          updatedAt: date,
          labels: ['size:S'],
          wayfinderLabels: [],
          parent: null,
          children: [],
          blockers: [],
          native: { state: 'OPEN', stateReason: null },
        },
      ],
    },
    histories: [fixtures.historyFrom([mandate])],
    catalogues: fixtureReviewClassCatalogues(),
  })
  const assessment = assessUwCompletion(observation)
  const projected = projectUwDelivery(observation, assessment, uw)
  expect(assessment.completions.get(scopeKey(uw))?.state).not.toBe('complete')
  expect(projected.ok).toBe(true)
  if (!projected.ok) throw new Error('expected delivery projection')
  expect(projected.value.effective.ok).toBe(true)
  expect(projected.value.declarations).toEqual([])
  expect(projected.value.verdicts).toEqual([])
  expect(projected.value.diagnostics.map((item) => item.code)).toContain('delivery-binding-ambiguous')
})

test('projects the authenticated C1 declaration and verdict only for their qualified UW', async () => {
  const first = await deliveredLeaf('Approve (clean)', 42)
  const second = await deliveredLeaf('Approve (clean)', 43)
  const firstNode = first.observation.graph.nodes[0]
  if (firstNode === undefined) throw new Error('Expected first native node')
  const observation = {
    ...first.observation,
    graph: {
      ...first.observation.graph,
      nodes: [{ ...firstNode, blockers: [second.uw] }, ...second.observation.graph.nodes],
    },
    histories: [...first.observation.histories, ...second.observation.histories],
    delivery: [...first.observation.delivery, ...second.observation.delivery],
  }
  const assessment = assessUwCompletion(observation)
  for (const fixture of [first, second]) {
    const projected = projectUwDelivery(observation, assessment, fixture.uw)
    if (!projected.ok) throw new Error('expected delivery projection')
    expect(assessment.completions.get(scopeKey(fixture.uw))?.state).toBe('complete')
    expect(projected.value.declarations).toHaveLength(1)
    expect(projected.value.verdicts).toHaveLength(1)
    const declaration = projected.value.declarations[0]
    const verdict = projected.value.verdicts[0]
    if (declaration === undefined || verdict === undefined)
      throw new Error('Expected projected declaration and verdict')
    expect(declaration.value.target).toMatchObject({ id: 'C1', spec: fixture.accepted.ref })
    expect(declaration.receipt).toEqual({
      source: 'record',
      record: { scope: fixture.uw, kind: 'action-receipt', recordId: fixture.implementation.recordId },
      selector: '/payload/structured/criteria/0',
      digest: canonicalValueDigest(fixture.declaration),
    })
    expect(verdict.value.target).toMatchObject({ id: 'C1', spec: fixture.accepted.ref })
    expect(verdict.source).toEqual({
      source: 'record',
      record: { scope: fixture.pullRequest, kind: 'contribution', recordId: fixture.review.spec.recordId },
      selector: '/payload/structured/specRows/0',
      digest: canonicalValueDigest(specReportSchema.parse(fixture.review.spec.payload.structured).specRows[0]),
    })
    expect(declaration.code).toEqual({ repository: fixture.uw.repository, commit: fixture.head })
    expect(verdict.code).toEqual({ repository: fixture.uw.repository, commit: fixture.head })
  }
})

test('read-only delivery inspection shows authentic Request changes without completing the UW', async () => {
  const fixture = await deliveredLeaf('Request changes')
  const before = JSON.stringify(fixture.observation)
  const assessment = assessUwCompletion(fixture.observation)
  const projected = projectUwDelivery(fixture.observation, assessment, fixture.uw)
  expect(assessment.completions.get(scopeKey(fixture.uw))?.state).not.toBe('complete')
  if (!projected.ok) throw new Error('expected read-only delivery projection')
  expect(projected.value.declarations).toHaveLength(1)
  expect(projected.value.verdicts).toHaveLength(1)
  expect(projected.value.declarations[0]?.value.target.spec).toEqual(fixture.accepted.ref)
  expect(JSON.stringify(fixture.observation)).toBe(before)
  expect(projected.value.diagnostics.map((item) => item.code)).toContain('delivery-review-not-approved')
})
