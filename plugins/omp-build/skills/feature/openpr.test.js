import { describe, expect, it } from 'vitest'
import { decodeHistory } from '../../dist/contracts.js'
import { AUTHOR, HEADS, historyPage, PR, REPOSITORY, reviewHistory } from './review-record-fixture.js'
import { readReviewRecords, reviewRecords } from './workflow-records.js'

describe('canonical review records', () => {
  it('derives the approval from the confirmed decision, not a rendered verdict', () => {
    const summary = reviewRecords(reviewHistory([{ head: HEADS[0], verdict: 'Approve (clean)' }]))
    expect(summary.ok).toBe(true)
    if (!summary.ok) throw new Error('canonical review history refused')
    expect(summary.value.verdict).toBe('Approve')
    expect(summary.value.head).toBe(HEADS[0])
    expect(summary.value.input).toBeNull()
    expect(summary.value.spent).toBe(false)
    expect(summary.value.reviewId).toBeTruthy()
  })

  it('reads every record through the shared GitHub adapter', async () => {
    const history = reviewHistory([{ head: HEADS[0], verdict: 'Approve' }])
    const calls = []
    const result = await readReviewRecords('/tmp/wt', PR, {
      gh: async (_cwd, args) => {
        calls.push(args)
        if (args[0] === 'repo') return JSON.stringify({ nameWithOwner: REPOSITORY })
        if (args[0] === 'api' && args[1] === 'user') return `${AUTHOR}\n`
        if (args[0] === 'api') return historyPage(history)
        throw new Error(`unexpected ${args.join(' ')}`)
      },
    })
    expect(result).toMatchObject({ ok: true, value: { verdict: 'Approve', head: HEADS[0] } })
    expect(calls.some((args) => String(args[1]).includes('/comments?per_page=100&page=1'))).toBe(true)
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
    expect(reviewRecords(decodeHistory(history.source))).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'legacy-format' })]),
    })
  })
})
