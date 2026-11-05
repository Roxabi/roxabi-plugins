import { describe, expect, it } from 'vitest'
import { decodeHistory } from '../../dist/contracts.js'
import { fixtureCatalogueGhResponse } from '../../testing/action-input-fixtures.ts'
import { fixtureHostReviewClassCatalogues } from '../../testing/host-catalogue-fixture.ts'
import { AUTHOR, HEADS, historyPage, PR, REPOSITORY, reviewHistory } from './review-record-fixture.js'
import { readReviewRecords, reviewRecords } from './workflow-records.js'

describe('canonical review records', () => {
  it('derives the approval from the confirmed decision, not a rendered verdict', () => {
    const summary = reviewRecords(reviewHistory([{ head: HEADS[0], verdict: 'Approve (clean)' }]), {
      catalogues: fixtureHostReviewClassCatalogues(),
    })
    expect(summary.ok).toBe(true)
    if (!summary.ok) throw new Error('canonical review history refused')
    expect(summary.value.verdict).toBe('Approve')
    expect(summary.value.head).toBe(HEADS[0])
    expect(summary.value.input).toBeNull()
    expect(summary.value.spent).toBe(false)
    expect(summary.value.reviewId).toBeTruthy()
  })

  it('derives approval and head from the fetched review history', async () => {
    const history = reviewHistory([{ head: HEADS[0], verdict: 'Approve' }])
    const result = await readReviewRecords('/tmp/wt', PR, {
      gh: async (_cwd, args) => {
        if (args[0] === 'repo') return JSON.stringify({ nameWithOwner: REPOSITORY })
        if (args[0] === 'api' && args[1] === 'user') return `${AUTHOR}\n`
        const catalogue = fixtureCatalogueGhResponse(args)
        if (catalogue !== null) return catalogue
        if (args[0] === 'api' && String(args[1]).startsWith(`repos/${REPOSITORY}/issues/${PR}/comments?`))
          return historyPage(history)
        throw new Error(`unexpected ${args.join(' ')}`)
      },
    })
    if (!result.ok) throw new Error(`review records refused: ${JSON.stringify(result.diagnostics)}`)
    expect(result).toMatchObject({ ok: true, value: { verdict: 'Approve', head: HEADS[0] } })
  })

  it('refuses legacy review markdown instead of treating it as an empty history', () => {
    const history = reviewHistory([])
    history.source.comments.push({
      locator: 'legacy',
      nativeId: '99',
      author: AUTHOR,
      createdAt: null,
      updatedAt: null,
      body: '<!-- omp-build:code-review -->\n**Verdict: Approve**',
    })
    expect(
      reviewRecords(decodeHistory(history.source), { catalogues: fixtureHostReviewClassCatalogues() }),
    ).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'legacy-format' })]),
    })
  })
})
