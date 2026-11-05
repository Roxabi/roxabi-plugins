import { describe, expect, it } from 'vitest'
import { AUTHOR, gateGh, HEADS, PR, reviewHistory } from './review-record-fixture.js'
import { readReviewRecords } from './workflow-records.js'

describe('record transport admission', () => {
  it('refuses a newer incomplete final review instead of falling back to an older approval', async () => {
    const approved = reviewHistory([{ head: HEADS[0], verdict: 'Approve (clean)' }])
    approved.source.comments.push({
      locator: 'partial-review',
      nativeId: '999',
      author: AUTHOR,
      createdAt: '2026-01-01T00:01:00Z',
      updatedAt: null,
      body: '<!-- omp-build-record v=1 kind=review id=review-new operationId=op-review-new part=1/2 data=e30 -->\n',
    })
    const { gh } = gateGh(approved)
    const result = await readReviewRecords('/tmp/wt', PR, { gh })
    expect(result).toMatchObject({
      ok: false,
      knownReviews: 2,
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'incomplete' })]),
    })
  })
})
