import { describe, expect, it } from 'vitest'
import { createReviewIdentity } from './review-records'

describe('review record identity', () => {
  it('keeps root and slot record identifiers deterministic within one operation', () => {
    const identity = createReviewIdentity({ runId: 'review-run', operationId: 'review-operation' })
    expect([identity.next('review-attempt'), identity.next('contribution'), identity.next('decision')]).toEqual([
      'review-run-review-attempt-1',
      'review-run-contribution-2',
      'review-run-decision-3',
    ])
  })
})
