import { expect, test } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { fixtureReviewClassCatalogues } from '../../testing/action-input-fixtures.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { specDigest } from '../record-digests.ts'
import type { UwCompletionObservation } from '../uw-completion-types.ts'
import { recheckComposedAssessmentDelta } from '../workflow-composed-material-preparation.ts'
import { assessFixture, mandateAssessmentState, proposedAssessmentState } from './workflow-spec-assessment-support.ts'
import { featureMandate, history } from './workflow-test-support.ts'

test('preexisting foreign assessment copies do not impersonate the newly published pair, while concurrent changes remain stale', () => {
  const mandate = featureMandate()
  const accepted = mandateAssessmentState(mandate)
  const proposed = proposedAssessmentState(accepted, { body: 'Revised bounded outcome' })
  const fixture = assessFixture(mandate, 'assessment-exact', accepted, proposed, 'editorial', [history([mandate])])
  const workflow = roxabiWorkflowFixtures()
  const encoded = workflow.historyFrom([mandate, fixture.start, fixture.result])
  const ownPair = encoded.operations.filter(
    (entry) => entry.recordId === fixture.start.recordId || entry.recordId === fixture.result.recordId,
  )
  expect(ownPair).toHaveLength(2)
  const pairLocators = new Set(ownPair.flatMap((entry) => entry.parts.map((part) => part.locator)))
  const originals = encoded.source.comments.filter((comment) => !pairLocators.has(comment.locator))
  const pair = encoded.source.comments.filter((comment) => pairLocators.has(comment.locator))
  const copies = pair.map((part, index) => ({
    ...part,
    locator: `foreign-pair-${index}`,
    nativeId: `foreign-pair-${index}`,
    author: 'intruder',
  }))
  const beforeHistory = decodeHistory({ ...encoded.source, comments: [...originals, ...copies] })
  const afterHistory = decodeHistory({ ...encoded.source, comments: [...originals, ...copies, ...pair] })
  const uw = { repository: mandate.repository, target: mandate.target }
  const date = '2026-10-27T12:00:00.000Z'
  const node = {
    uw,
    title: 'parent',
    raw: { reference: uw.target, body: '', bodySha256: specDigest(''), lastEditedAt: date },
    updatedAt: date,
    labels: ['size:S'],
    wayfinderLabels: [],
    parent: null,
    children: [],
    blockers: [],
    native: { state: 'OPEN' as const, stateReason: null },
  }
  const before: Extract<UwCompletionObservation, { status: 'complete' }> = {
    status: 'complete',
    root: uw,
    graph: { status: 'complete', root: uw, observedAt: date, nodes: [node] },
    histories: [beforeHistory],
    catalogues: fixtureReviewClassCatalogues(),
    delivery: [],
  }
  const after = { ...before, histories: [afterHistory] }
  const assessment = { scope: uw, recordId: fixture.result.recordId, kind: 'action-receipt' as const }
  const mandateRef = { scope: uw, recordId: mandate.recordId, kind: 'mandate' as const }
  const beforeWithoutCopies = { ...before, histories: [decodeHistory({ ...encoded.source, comments: originals })] }
  const afterWithoutCopies = {
    ...after,
    histories: [decodeHistory({ ...encoded.source, comments: [...originals, ...pair] })],
  }
  expect(
    recheckComposedAssessmentDelta({
      before: beforeWithoutCopies,
      after: afterWithoutCopies,
      assessment,
      mandate: mandateRef,
    }).ok,
  ).toBe(true)
  expect(
    recheckComposedAssessmentDelta({ before: beforeWithoutCopies, after, assessment, mandate: mandateRef }).ok,
  ).toBe(false)
  expect(beforeHistory.operations.filter((entry) => entry.authority === 'foreign')).toHaveLength(2)
  expect(recheckComposedAssessmentDelta({ before, after, assessment, mandate: mandateRef })).toMatchObject({
    ok: true,
    value: { recordId: fixture.result.recordId },
  })
})
