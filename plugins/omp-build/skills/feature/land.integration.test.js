import { describe, expect, it } from 'vitest'
import { AUTHOR, HEADS, historyPage, PR, REPOSITORY, reviewHistory } from './review-record-fixture.js'
import { readReviewRecords } from './workflow.js'

describe('record transport admission', () => {
  it('refuses a newer incomplete final review instead of falling back to an older approval', async () => {
    const approved = reviewHistory([{ head: HEADS[0], verdict: 'Approve (clean)' }])
    const result = await readReviewRecords('/tmp/wt', PR, {
      gh: async (_cwd, args) => {
        if (args[0] === 'repo') return JSON.stringify({ nameWithOwner: REPOSITORY })
        if (args[0] === 'api' && args[1] === 'user') return `${AUTHOR}\n`
        if (args[0] === 'api')
          return JSON.stringify([
            ...JSON.parse(historyPage(approved)),
            {
              id: 999,
              user: { login: AUTHOR },
              created_at: '2026-01-01T00:01:00Z',
              updated_at: null,
              body: '<!-- omp-build-record v=1 kind=review id=review-new operationId=op-review-new part=1/2 data=e30 -->\n',
            },
          ])
        throw new Error(`unexpected ${args.join(' ')}`)
      },
    })
    expect(result).toMatchObject({
      ok: false,
      knownReviews: 2,
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'incomplete' })]),
    })
  })
})
