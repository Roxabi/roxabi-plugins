import { describe, expect, test } from 'vitest'
import { reviewRoot, TEST_HEAD } from '../../testing/record-builders.ts'
import { finalReview } from '../../testing/record-decisions.ts'
import { reviewGraph } from '../../testing/record-graphs.ts'
import { history, operation } from '../../testing/record-history.ts'
import { deriveReviewState, summarizeReviews } from '../review-state.ts'
import { refusalCodes, reviewFacts, TAXONOMY } from './record-test-support.ts'

describe('review accounting and stops', () => {
  test('does not fall back to an older green review after a newer partial publication', () => {
    const green = reviewGraph({ prefix: 'green', empty: true })
    const partial = operation(green.review, {
      operationId: 'op-newer-partial',
      recordId: 'newer-partial',
      status: 'incomplete',
      record: null,
    })
    const summary = summarizeReviews(
      { ...green.history, operations: [...green.history.operations, partial] },
      TAXONOMY,
      null,
    )

    expect(summary).toMatchObject({ ok: false, knownReviews: 2, countExact: true, spent: false })
    expect(refusalCodes(summary)).toContain('incomplete')
  })

  test('refuses an abandoned newer initial review without replacing it by an older clean approval', () => {
    const older = reviewGraph({ prefix: 'older-clean', empty: true })
    const abandoned = reviewRoot({ id: 'newer-abandoned', head: TEST_HEAD })
    const interrupted = history([...older.records, abandoned])
    const delayedOlderFinal = finalReview({
      id: 'delayed-older-final',
      operationId: 'op-delayed-older-final',
      head: TEST_HEAD,
      inventoryIds: older.review.payload.inventoryIds,
      decisionId: older.decision.recordId,
    })
    const staleFinal = history([...older.records, abandoned, delayedOlderFinal])
    const resumed = reviewGraph({ prefix: 'resumed-clean', empty: true })

    expect(summarizeReviews(interrupted, TAXONOMY, null)).toMatchObject({
      ok: false,
      knownReviews: 1,
      countExact: true,
      spent: false,
    })
    expect(refusalCodes(summarizeReviews(interrupted, TAXONOMY, null))).toContain('incomplete')
    expect(deriveReviewState(interrupted, reviewFacts(), TAXONOMY)).toMatchObject({
      ok: false,
      next: 'stop',
      knownReviews: 1,
      countExact: true,
      spent: false,
    })
    expect(summarizeReviews(staleFinal, TAXONOMY, null)).toMatchObject({
      ok: false,
      knownReviews: 2,
      countExact: true,
      spent: false,
      diagnostics: [
        expect.objectContaining({
          code: 'incomplete',
          detail: { rootId: 'newer-abandoned', pendingRoot: true },
        }),
      ],
    })
    expect(summarizeReviews(history([...older.records, abandoned, ...resumed.records]), TAXONOMY, null)).toMatchObject({
      ok: true,
      value: { reviews: 2, verdict: 'Approve (clean)', spent: false },
    })
  })

  test('counts an identical publication operation once and rejects a conflicting final operation', () => {
    const green = reviewGraph({ prefix: 'duplicate-green', empty: true })
    const duplicate = operation(green.review, {
      parts: [operation(green.review).parts[0], operation(green.review).parts[0]],
    })
    const deduplicated = summarizeReviews(
      { ...green.history, operations: [...green.history.operations, duplicate] },
      TAXONOMY,
      null,
    )
    const conflict = operation(green.review, {
      operationId: 'op-conflict',
      recordId: 'conflict-review',
      status: 'conflict',
      record: null,
    })
    const conflicted = summarizeReviews(
      {
        ...green.history,
        operations: [...green.history.operations, conflict],
        diagnostics: [{ code: 'conflict', message: 'Two records claim one review operation.' }],
      },
      TAXONOMY,
      null,
    )

    expect(deduplicated).toMatchObject({
      ok: true,
      value: { reviews: 1, verdict: 'Approve (clean)', reviewId: 'duplicate-green-final' },
    })
    expect(conflicted).toMatchObject({ ok: false, knownReviews: 2, countExact: true, spent: false })
    expect(refusalCodes(conflicted)).toContain('conflict')
    expect(summarizeReviews(history([]), TAXONOMY, null)).toMatchObject({
      ok: true,
      value: { reviews: 0, reviewId: null },
    })
  })

  test('keeps a third red review bound across a new head', () => {
    const first = reviewGraph({ prefix: 'first-red', label: 'issue(blocking)' })
    const second = reviewGraph({ prefix: 'second-red', label: 'issue(blocking)' })
    const third = reviewGraph({ prefix: 'third-red', label: 'issue(blocking)' })
    const state = deriveReviewState(
      history([...first.records, ...second.records, ...third.records]),
      reviewFacts('2222222222222222222222222222222222222222'),
      TAXONOMY,
    )

    expect(state).toMatchObject({
      ok: true,
      next: 'stop',
      summary: { reviews: 3, verdict: 'Request changes', spent: true },
      requiredStop: { reason: 'review-bound', reviewId: 'third-red-final' },
    })
  })

  test('requires a sticky CI stop when the third review is green and CI turns red', () => {
    const first = reviewGraph({ prefix: 'first-green', empty: true })
    const second = reviewGraph({ prefix: 'second-green', empty: true })
    const third = reviewGraph({ prefix: 'third-green', empty: true })
    const state = deriveReviewState(
      history([...first.records, ...second.records, ...third.records]),
      reviewFacts(TEST_HEAD, 'red'),
      TAXONOMY,
    )

    expect(state).toMatchObject({
      ok: true,
      next: 'stop',
      summary: { reviews: 3, verdict: 'Approve (clean)', spent: true },
      requiredStop: { reason: 'ci-failed', reviewId: 'third-green-final', detail: { reviews: 3, ci: 'red' } },
    })
  })

  test('creates a CI stop only for the latest approving review on the fresh head', () => {
    const first = reviewGraph({ prefix: 'fresh-first', empty: true, head: TEST_HEAD })
    const second = reviewGraph({ prefix: 'fresh-second', empty: true, head: TEST_HEAD })
    const third = reviewGraph({ prefix: 'fresh-third', empty: true, head: TEST_HEAD })
    const foreignHead = '2222222222222222222222222222222222222222'
    const fourth = reviewGraph({ prefix: 'foreign-fourth', empty: true, head: foreignHead })
    const records = history([...first.records, ...second.records, ...third.records, ...fourth.records])

    expect(deriveReviewState(records, reviewFacts(TEST_HEAD, 'red'), TAXONOMY)).toMatchObject({
      ok: true,
      next: 'review',
      requiredStop: null,
    })
    expect(
      deriveReviewState(
        records,
        { ...reviewFacts(foreignHead, 'red'), input: null, proofAdmission: { ok: false, diagnostics: [] } },
        TAXONOMY,
      ),
    ).toMatchObject({
      ok: true,
      next: 'stop',
      requiredStop: { reason: 'ci-failed', reviewId: 'foreign-fourth-final' },
    })
  })

  test('waits on fresh red CI before a matching third-review stop exists', () => {
    const green = reviewGraph({ prefix: 'fresh-red-ci', empty: true })

    expect(deriveReviewState(green.history, reviewFacts(TEST_HEAD, 'red'), TAXONOMY)).toMatchObject({
      ok: true,
      next: 'wait',
      requiredStop: null,
      summary: { reviews: 1, verdict: 'Approve (clean)', spent: false },
    })
  })
})
