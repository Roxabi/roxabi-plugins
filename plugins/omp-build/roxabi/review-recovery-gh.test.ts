import { describe, expect, test } from 'vitest'
import { githubScope } from '../adapters/github/transport.ts'
import { TAXONOMY } from '../engine/__tests__/record-test-support.ts'
import { SCOPE } from '../engine/__tests__/workflow-test-support.ts'
import { readReviewRecovery } from '../engine/review-recovery.ts'
import { deriveReviewState, summarizeReviews } from '../engine/review-state.ts'
import { TEST_HEAD } from '../testing/record-builders.ts'
import { withRoxabiGitHubPolicy } from './github-policy.ts'
import { createGitHubRecordPublisher } from './github-publisher.ts'
import {
  ghGrantInterruptedReviewReplacement,
  ghReplaceInterruptedReview,
  ghTerminalizeInterruptedReview,
} from './review-recovery-gh.ts'
import {
  completedReplacementRecords,
  preparedReview,
  recoveryFixture,
  recoveryFreshInput,
  recoverySmokeCwd,
} from './review-recovery-gh-test-support.ts'
import { readReviewInputHistories } from './uw-input-readers.ts'

describe('GitHub interrupted-review recovery publication', () => {
  test('runs D→G→R2 through the native GitHub reader, codec and confirmed publisher', async () => {
    const fixture = recoveryFixture()
    const prepareReview = async () => preparedReview()

    const terminal = await ghTerminalizeInterruptedReview({ cwd: recoverySmokeCwd, pr: 42, gh: fixture.gh })
    expect(terminal).toMatchObject({ ok: true })
    const afterTerminal = await fixture.history()
    expect(readReviewRecovery(afterTerminal)).toMatchObject({
      ok: true,
      value: { normalProgression: 'stopped', replacementGrant: null },
    })
    expect(summarizeReviews(afterTerminal, TAXONOMY, null)).toMatchObject({ ok: false })

    const grant = await ghGrantInterruptedReviewReplacement({
      cwd: recoverySmokeCwd,
      pr: 42,
      contextWindow: 128_000,
      gh: fixture.gh,
      prepareReview,
      operations: preparedReview().value.operations,
    })
    expect(grant).toMatchObject({ ok: true })
    if (!grant.ok) return
    const afterGrant = await fixture.history()
    expect(readReviewRecovery(afterGrant)).toMatchObject({
      ok: true,
      value: { normalProgression: 'stopped', replacementGrant: { recordId: grant.value.recordId } },
    })

    const replacement = await ghReplaceInterruptedReview({
      cwd: recoverySmokeCwd,
      pr: 42,
      contextWindow: 128_000,
      gh: fixture.gh,
      prepareReview,
      operations: preparedReview().value.operations,
    })
    expect(replacement).toMatchObject({ ok: true, value: { grantId: grant.value.recordId } })
    if (!replacement.ok) return
    const afterReplacement = await fixture.history()
    expect(readReviewRecovery(afterReplacement)).toMatchObject({
      ok: true,
      value: { normalProgression: 'stopped', replacementGrant: null },
    })
    const inventory = afterReplacement.operations.find(
      (operation) => operation.recordId === replacement.value.recordId,
    )?.record
    expect(inventory).toEqual(replacement.value.inventory)
    expect(inventory).toMatchObject({
      kind: 'review-attempt',
      inputs: expect.arrayContaining([grant.value.recordId]),
    })
    if (inventory?.kind !== 'review-attempt') throw new Error('confirmed replacement inventory missing')

    const beforeRetry = fixture.commentCount()
    const retry = await ghReplaceInterruptedReview({
      cwd: recoverySmokeCwd,
      pr: 42,
      contextWindow: 128_000,
      gh: fixture.gh,
      prepareReview,
      operations: preparedReview().value.operations,
    })
    expect(retry).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'unbound' })]),
    })
    expect(fixture.commentCount()).toBe(beforeRetry)
    expect(
      (await fixture.history()).operations.filter(
        (operation) => operation.record?.kind === 'review-attempt' && operation.record.payload.stage === 'initial',
      ),
    ).toHaveLength(2)

    const publisher = createGitHubRecordPublisher(
      githubScope(SCOPE.repository, 42),
      withRoxabiGitHubPolicy({ cwd: recoverySmokeCwd, gh: fixture.gh }),
      { taxonomy: TAXONOMY, acceptedPolicy: null },
    )
    for (const record of completedReplacementRecords(inventory))
      expect(await publisher.publish(record)).toMatchObject({ ok: true })
    const completed = await fixture.history()
    const cited = await readReviewInputHistories(completed, { cwd: recoverySmokeCwd, gh: fixture.gh })
    expect(cited.ok).toBe(true)
    if (!cited.ok) throw new Error('cited histories unavailable')
    expect(readReviewRecovery(completed)).toMatchObject({
      ok: true,
      value: { normalProgression: 'eligible', replacementGrant: null },
    })
    expect(summarizeReviews(completed, TAXONOMY, null, cited.value)).toMatchObject({
      ok: true,
      value: { reviews: 1, verdict: 'Request changes' },
    })
    expect(
      deriveReviewState(
        completed,
        {
          ...SCOPE,
          candidateGitSHA: TEST_HEAD,
          input: recoveryFreshInput,
          ci: 'green',
          acceptedEvidencePolicyRef: null,
        },
        TAXONOMY,
        cited.value,
      ),
    ).toMatchObject({ ok: true, next: 'fix' })
  })

  test('selects B1 by I4 when a second valid same-scope binding and mandate exists', async () => {
    const fixture = recoveryFixture({ associations: 'second' })
    const terminal = await ghTerminalizeInterruptedReview({ cwd: recoverySmokeCwd, pr: 42, gh: fixture.gh })

    expect(terminal).toMatchObject({ ok: true })
    if (!terminal.ok) return
    expect(
      (await fixture.history()).operations.find((operation) => operation.recordId === terminal.value.recordId)?.record,
    ).toMatchObject({
      kind: 'review-interruption',
      payload: { historicalBinding: { recordId: fixture.historicalBinding.recordId } },
    })
  })

  test('refuses a missing I4 match without publication', async () => {
    const fixture = recoveryFixture({ associations: 'none' })
    const before = fixture.commentCount()
    const terminal = await ghTerminalizeInterruptedReview({ cwd: recoverySmokeCwd, pr: 42, gh: fixture.gh })

    expect(terminal).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'ambiguous' })]),
    })
    expect(fixture.commentCount()).toBe(before)
  })

  test('refuses contradictory duplicate binding identity at the canonical encode boundary', () => {
    const fixture = recoveryFixture()
    const before = fixture.commentCount()

    expect(fixture.duplicateBindingEncoding()).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'duplicate-reference' })]),
    })
    expect(fixture.commentCount()).toBe(before)
  })

  for (const [scenario, options] of [
    ['post response author', { postResponseAuthor: 'intruder', postStoredAuthor: 'automation' }],
    ['confirmed readback author', { postResponseAuthor: 'automation', postStoredAuthor: 'intruder' }],
  ] as const) {
    test(`refuses a mismatched ${scenario} and leaves recovery non-green`, async () => {
      const fixture = recoveryFixture(options)
      const terminal = await ghTerminalizeInterruptedReview({ cwd: recoverySmokeCwd, pr: 42, gh: fixture.gh })

      expect(terminal).toMatchObject({ ok: false })
      expect(summarizeReviews(await fixture.history(), TAXONOMY, null)).toMatchObject({ ok: false })
    })
  }
})
