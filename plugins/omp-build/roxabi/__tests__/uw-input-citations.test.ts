import { describe, expect, it } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { canonicalValueDigest } from '../../engine/action-input.ts'
import { classifyHistory } from '../../engine/history-classification.ts'
import { authenticatedReview, causeOriginalHistory } from '../../testing/cause-input-fixture.ts'
import { confirmCitedRefs } from '../uw-input-citations.ts'

const { graph } = authenticatedReview()
const review = graph.review
const ref = {
  source: 'record' as const,
  record: {
    scope: graph.history.source.scope,
    kind: review.kind,
    recordId: review.recordId,
  },
  selector: '/payload',
  digest: canonicalValueDigest(review.payload),
}
const original = causeOriginalHistory()
const selected = graph.history
const isReview = (body: string) => body.includes(`kind=review id=${review.recordId} `)
const alter = (
  change: (comment: (typeof selected.source.comments)[number]) => (typeof selected.source.comments)[number],
) =>
  decodeHistory({
    ...selected.source,
    comments: selected.source.comments.map((comment) => (isReview(comment.body) ? change(comment) : comment)),
  })

describe.each(['root', 'external'] as const)('cited review in %s history', (position) => {
  const closure = (history: typeof selected) => (position === 'root' ? [history, original] : [original, history])

  it('accepts an authenticated authority-class review', () => {
    const operation = classifyHistory(selected).classes.find((entry) => entry.operationId === review.operationId)
    expect(operation?.authority).toBe('authority')
    expect(confirmCitedRefs([ref], closure(selected))).toEqual({ ok: true, value: true })
  })

  it('refuses missing, conflicting, incomplete, foreign, unknown-author, edited and malformed selected histories', () => {
    const foreign = alter((comment) => ({ ...comment, author: 'foreign-operator' }))
    const unknown = alter((comment) => ({ ...comment, author: null }))
    const edited = alter((comment) => ({ ...comment, updatedAt: '2026-10-27T12:01:00Z' }))
    const unreadableTime = alter((comment) => ({ ...comment, updatedAt: null }))
    const malformed = alter((comment) => ({
      ...comment,
      body: `<!-- omp-build-record v=1 kind=review id=${review.recordId} operationId=${review.operationId} part=1/2 data=e30 -->`,
    }))
    const incomplete = decodeHistory({ ...selected.source, complete: false })
    const missing = decodeHistory({
      ...selected.source,
      comments: selected.source.comments.filter((comment) => !isReview(comment.body)),
    })
    for (const history of [foreign, unknown, edited, unreadableTime, malformed, incomplete, missing])
      expect(confirmCitedRefs([ref], closure(history)).ok).toBe(false)
    expect(confirmCitedRefs([ref], [...closure(selected), selected]).ok).toBe(false)
    expect(confirmCitedRefs([ref], [original]).ok).toBe(false)
  })
})
