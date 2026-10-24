import { describe, expect, it } from 'vitest'
import { disarmReviewedBeforePush } from './landing-foundation.js'
import { gateGh, HEADS, PR, reviewHistory } from './review-record-fixture.js'

describe('review start gate boundary', () => {
  it('confirms both arms are cleared before a review-start push callback', async () => {
    const { gh, state } = gateGh(reviewHistory([]), { head: HEADS[0], armed: true })
    let pushed = false
    await expect(
      disarmReviewedBeforePush('/tmp/wt', PR, {
        gh,
        push: () => {
          pushed = true
        },
      }),
    ).resolves.toEqual({ disarmed: true })
    expect(state.label).toBe(false)
    expect(state.auto).toBe(false)
    expect(pushed).toBe(true)
  })
})
