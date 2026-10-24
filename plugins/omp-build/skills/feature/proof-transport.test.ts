import { describe, expect, it } from 'vitest'
import { decodeHistory, githubScope, type History } from '../../dist/contracts.js'
import { findProofRecord } from './proof-records'

const repository = 'acme/app'
const candidate = '1111111111111111111111111111111111111111'

describe('legacy proof transport', () => {
  it('refuses an explicit historical proof frame instead of treating it as no proof', () => {
    const history: History = {
      scope: githubScope(repository, 1),
      expectedAuthor: 'operator',
      stopAuthor: null,
      complete: true,
      comments: [
        {
          locator: `${repository}#1:comment:1`,
          nativeId: '1',
          author: 'operator',
          body: `<!-- omp-build:proof producer=semctx -->\n<!-- omp-build:proof-head sha=${candidate} -->`,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
      diagnostics: [],
    }

    expect(findProofRecord(decodeHistory(history), 'semctx', candidate)).toMatchObject({
      unreadable: expect.stringContaining('legacy'),
    })
  })
})
