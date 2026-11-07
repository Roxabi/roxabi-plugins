import { expect, test } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { fixtureReviewClassCatalogues } from '../../testing/action-input-fixtures.ts'
import { encodedAdmissionReviewGraph } from '../../testing/record-admission.ts'
import { observedComment } from '../../testing/record-history.ts'
import { roxabiRecordFixtures } from '../../testing/roxabi-presets.ts'
import { validateReviewDecisionBindings } from '../review-decision.ts'
import { readReviewRecovery } from '../review-recovery.ts'

function fixture() {
  const graph = encodedAdmissionReviewGraph(roxabiRecordFixtures().projection, { prefix: 'legacy-recovery' })
  const review = graph.history.operations.find((entry) => entry.record?.kind === 'review')?.record
  if (review?.kind !== 'review') throw new Error('Expected actual decoded review')
  const catalogues = fixtureReviewClassCatalogues()
  return { graph, review, catalogues }
}

test.each(['review-attempt', 'review-interruption', 'review-replacement-grant'] as const)(
  'a foreign legacy %s cannot veto an authenticated review decision',
  (kind) => {
    const { graph, review, catalogues } = fixture()
    const baseline = validateReviewDecisionBindings(review, graph.history, catalogues)
    expect(baseline, JSON.stringify(baseline)).toMatchObject({
      ok: true,
      value: { review, decision: { recordId: review.payload.decisionId } },
    })
    const recovery = readReviewRecovery(graph.history)
    expect(recovery.ok, JSON.stringify(recovery)).toBe(true)
    const foreign = observedComment({
      locator: `foreign-${kind}`,
      nativeId: `foreign-${kind}`,
      author: 'intruder',
      body: `<!-- omp-build:${kind} -->`,
    })
    const noisy = decodeHistory({ ...graph.history.source, comments: [...graph.history.source.comments, foreign] })
    expect(noisy.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind, status: 'legacy', authority: 'foreign', record: null }),
        expect.objectContaining({ kind: 'review', recordId: review.recordId, status: 'complete', record: review }),
      ]),
    )
    expect(readReviewRecovery(noisy)).toEqual(recovery)
    expect(validateReviewDecisionBindings(review, noisy, catalogues)).toMatchObject({
      ok: true,
      value: { review, decision: { recordId: review.payload.decisionId } },
    })
  },
)

test('expected-author recovery damage and absent or stale review authority remain refused', () => {
  const { graph, review, catalogues } = fixture()
  const baseline = validateReviewDecisionBindings(review, graph.history, catalogues)
  expect(baseline.ok, JSON.stringify(baseline)).toBe(true)
  const legacy = observedComment({
    locator: 'trusted-legacy',
    nativeId: 'trusted-legacy',
    author: graph.history.source.expectedAuthor,
    body: '<!-- omp-build:review-attempt -->',
  })
  const partial = observedComment({
    locator: 'trusted-partial',
    nativeId: 'trusted-partial',
    author: graph.history.source.expectedAuthor,
    body: '<!-- omp-build-record v=1 kind=review-interruption id=partial operationId=op-partial part=1/2 data=e30 -->\n# partial',
  })
  for (const comment of [legacy, partial]) {
    const damaged = decodeHistory({ ...graph.history.source, comments: [...graph.history.source.comments, comment] })
    expect(validateReviewDecisionBindings(review, damaged, catalogues).ok).toBe(false)
  }
  const foreignOnly = decodeHistory({
    ...graph.history.source,
    comments: [{ ...legacy, author: 'intruder' }],
  })
  expect(validateReviewDecisionBindings(review, foreignOnly, catalogues).ok).toBe(false)
  const other = encodedAdmissionReviewGraph(roxabiRecordFixtures().projection, { prefix: 'other-review' })
  const stale = other.history.operations.find((entry) => entry.record?.kind === 'review')?.record
  if (stale?.kind !== 'review') throw new Error('Expected another decoded review')
  expect(validateReviewDecisionBindings(stale, graph.history, catalogues).ok).toBe(false)
})
