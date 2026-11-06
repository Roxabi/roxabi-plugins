import { expect, it } from 'vitest'
import { boundInput, cleanReview, seedMandate } from '../testing/review-gate-arrangement.ts'
import {
  postCalls,
  publish,
  readState,
  runReviewGate,
  setupReviewGateFixture,
  writeState,
} from '../testing/review-gate-fixture.ts'

export function registerMandateIntegrityCases(): void {
  it.each(['review', 'review-attempt', 'decision', 'mandate', 'workflow-binding'] as const)(
    'refuses an edited %s record without persistent effects',
    async (kind) => {
      const fixture = setupReviewGateFixture()
      await seedMandate(fixture)
      publish(fixture, cleanReview(fixture, fixture.head, 'integrity', await boundInput(fixture)), 'SUCCESS')
      const state = readState(fixture)
      const comment =
        kind === 'mandate'
          ? state.issues['42']?.comments.find((entry) => entry.body.includes('kind=mandate '))
          : state.comments.find((entry) => entry.body.includes(`kind=${kind} `))
      if (!comment) throw new Error(`missing ${kind} fixture record`)
      comment.updated_at = '2026-10-21T00:00:01Z'
      writeState(fixture, state)

      const result = runReviewGate(fixture)
      const body = JSON.parse(result.stdout)

      expect(result.status).toBe(1)
      expect(body).toMatchObject({ ok: false, allowed: false })
      if (kind === 'review' || kind === 'review-attempt' || kind === 'decision')
        expect(body).toMatchObject({ reason: 'record-edited' })
      expect(postCalls(fixture)).toEqual([])
    },
  )

  it.each(['review-attempt', 'decision'] as const)('refuses a foreign-author %s record', async (kind) => {
    const fixture = setupReviewGateFixture()
    await seedMandate(fixture)
    publish(fixture, cleanReview(fixture, fixture.head, 'foreign', await boundInput(fixture)), 'SUCCESS')
    const state = readState(fixture)
    const comment = state.comments.find((entry) => entry.body.includes(`kind=${kind} `))
    if (!comment) throw new Error(`missing ${kind} fixture record`)
    comment.user.login = 'foreign-automation'
    writeState(fixture, state)

    const result = runReviewGate(fixture)

    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, allowed: false })
  })

  it('refuses an approval with absent native revision metadata', async () => {
    const fixture = setupReviewGateFixture()
    await seedMandate(fixture)
    publish(fixture, cleanReview(fixture, fixture.head, 'unreadable', await boundInput(fixture)), 'SUCCESS')
    const state = readState(fixture)
    const review = state.comments.find((comment) => comment.body.includes('kind=review '))
    if (!review) throw new Error('missing review fixture record')
    delete (review as Partial<typeof review>).updated_at
    writeState(fixture, state)

    const result = runReviewGate(fixture)

    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, allowed: false, reason: 'record-unreadable' })
  })
}
