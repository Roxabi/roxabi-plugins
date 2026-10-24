import { describe, expect, it } from 'vitest'
import { contribution } from '../testing/record-decisions.ts'
import type { FixRecord } from './fix-contract.ts'
import { captureConfirmedFixRequest } from './fix-entry-review-bound.ts'

describe('review-bound fix entry', () => {
  it('captures only the exact fix request whose publication succeeded', async () => {
    const source = contribution({ id: 'review-source', inventoryId: null, content: 'operator-request' })
    const request: Extract<FixRecord, { kind: 'fix-request' }> = {
      ...source,
      recordId: 'review-request',
      operationId: 'review-request-operation',
      inputs: [source.recordId],
      kind: 'fix-request',
      payload: {
        requestContributionId: source.recordId,
        existingReviewId: 'review-1',
        scope: 'correct the review finding',
        landing: false,
      },
    }
    let published = false
    let captured: Extract<FixRecord, { kind: 'fix-request' }> | undefined
    const publisher = captureConfirmedFixRequest(
      {
        publish: async () =>
          published ? { ok: true as const, value: undefined } : { ok: false as const, diagnostics: ['publish-failed'] },
      },
      (record) => {
        captured = record
      },
    )

    expect((await publisher.publish(request)).ok).toBe(false)
    expect(captured).toBeUndefined()
    published = true
    expect((await publisher.publish(request)).ok).toBe(true)
    expect(captured).toBe(request)
  })
})
