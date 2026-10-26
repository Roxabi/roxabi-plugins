import { describe, expect, it } from 'vitest'
import { boundInput, cleanReview, seedMandate } from '../testing/review-gate-arrangement.ts'
import {
  publish,
  type ReviewGateFixture,
  readState,
  runReviewGate,
  setupReviewGateFixture,
  writeState,
} from '../testing/review-gate-fixture.ts'

function mutateMandatePayload(fixture: ReviewGateFixture, mutate: (payload: Record<string, unknown>) => void): void {
  const state = readState(fixture)
  const comment = state.issues['42']?.comments.find((entry) => entry.body.includes('kind=mandate '))
  if (!comment) throw new Error('missing mandate fixture record')
  const match = /data=([A-Za-z0-9_-]+)/.exec(comment.body)
  if (!match?.[1]) throw new Error('mandate fixture record has no data')
  const record = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8')) as { payload: Record<string, unknown> }
  mutate(record.payload)
  comment.body = comment.body.replace(match[1], Buffer.from(JSON.stringify(record)).toString('base64url'))
  writeState(fixture, state)
}

export function registerReviewGateFormatCases(): void {
  describe('review-gate CLI record formats', () => {
    it.each([
      ['missing format', (payload: Record<string, unknown>) => delete payload.format],
      ['removed proof pins', (payload: Record<string, unknown>) => (payload.proofPins = [])],
    ])('refuses a mandate with %s as incompatible format', async (_name, mutate) => {
      const fixture = setupReviewGateFixture()
      await seedMandate(fixture)
      publish(fixture, cleanReview(fixture.head, 'old-format', await boundInput(fixture)), 'SUCCESS')
      mutateMandatePayload(fixture, mutate)
      const result = runReviewGate(fixture)
      expect(result.status).toBe(1)
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        allowed: false,
        reason: 'incompatible-format',
        detail: [{ code: 'incompatible-format' }],
      })
    })
  })
}
