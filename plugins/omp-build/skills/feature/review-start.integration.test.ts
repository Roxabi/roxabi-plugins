import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { disarmReviewedBeforePush } from './landing-foundation.js'
import { gateGh, HEADS, PR, reviewHistory } from './review-record-fixture.js'
import { readGate } from './workflow-gate.js'

beforeEach(() => {
  vi.stubEnv('HEAD_AUTH_REPOSITORY_ID', '1')
  vi.stubEnv('HEAD_AUTH_OPERATOR_IDS', '[101]')
  vi.stubEnv('HEAD_AUTH_APP_ID', '200')
  vi.stubEnv('HEAD_AUTH_BOT_USER_ID', '201')
})
afterEach(() => vi.unstubAllEnvs())

describe('review start gate boundary', () => {
  it('confirms both arms are cleared before a review-start push callback', async () => {
    const { gh, state } = gateGh(reviewHistory([]), { head: HEADS[0], armed: true })
    let pushed = false
    await expect(
      disarmReviewedBeforePush('/tmp/wt', PR, {
        gh,
        push: async () => {
          expect((await readGate('/tmp/wt', PR, gh)).authorization?.allowed).toBe(false)
          pushed = true
        },
      }),
    ).resolves.toEqual({ disarmed: true })
    expect(state.label).toBe(false)
    expect(state.auto).toBe(false)
    expect(pushed).toBe(true)
  })
})
