import { expect, it } from 'vitest'
import type { Gh } from '../../adapters/github/types.ts'
import { UW_GRAPH_QUERY } from '../../adapters/github-native/uw-graph-query.ts'
import { createInstalledUwOperations } from '../uw-installed-operations.ts'
import { closeLinkedWorld } from './uw-close-linked-fixture.ts'

it('reports a partial close when the final readback binding observes a removed review', async () => {
  const f = await closeLinkedWorld()
  const operation = f.leaf.review.history.operations.find((entry) => entry.recordId === f.leaf.review.review.recordId)
  if (!operation) throw new Error('Expected the selected review')
  const locators = new Set(operation.parts.map((part) => part.locator))
  const ids = f.leaf.review.history.source.comments.flatMap((comment, index) =>
    locators.has(comment.locator) ? [index + 1] : [],
  )
  if (ids.length === 0) throw new Error('Expected native review comment parts')
  let postEffectHistories = 0
  let removed = false
  const roots: { afterEffect: boolean; issue: Record<string, unknown> }[] = []
  const reviewObservations: { afterEffect: boolean; afterRemoval: boolean; present: boolean }[] = []
  function recordHistory(response: string) {
    const comments: { id: number }[] = JSON.parse(response)
    reviewObservations.push({
      afterEffect: f.effects.includes('close'),
      afterRemoval: removed,
      present: ids.every((id) => comments.some((comment) => comment.id === id)),
    })
  }
  function recordRoot(args: string[], response: string) {
    if (args[0] === 'api' && args[1] === 'graphql' && args[3] === `query=${UW_GRAPH_QUERY}`)
      roots.push({ afterEffect: f.effects.includes('close'), issue: JSON.parse(response).data.repository.issue })
  }
  const gh: Gh = async (cwd, args) => {
    const history = args[0] === 'api' && args[1] === 'repos/acme/app/issues/142/comments?per_page=100&page=1'
    if (history && f.effects.includes('close')) postEffectHistories++
    if (history && postEffectHistories === 2 && !removed) {
      f.removeReview()
      removed = true
    }
    const response = await f.gh(cwd, args)
    if (history) recordHistory(response)
    recordRoot(args, response)
    return response
  }
  const operations = await createInstalledUwOperations({
    cwd: '/simulated',
    gh,
    readAuthor: 'operator',
    operator: {
      async executeConfirmed() {
        throw new Error('No operator mutation authorized')
      },
    },
  })
  const result = await operations.closeLinked(f.request)
  expect(removed).toBe(true)
  expect(reviewObservations).toContainEqual({ afterEffect: true, afterRemoval: false, present: true })
  expect(reviewObservations).toContainEqual({ afterEffect: true, afterRemoval: true, present: false })
  const before = roots.filter((root) => !root.afterEffect).map((root) => root.issue)
  const after = roots.filter((root) => root.afterEffect).map((root) => root.issue)
  expect(before.length).toBeGreaterThan(0)
  expect(after.length).toBeGreaterThan(0)
  for (const issue of before) expect(issue).toEqual(before[0])
  for (const issue of after) expect(issue).toEqual({ ...before[0], state: 'CLOSED', stateReason: 'COMPLETED' })
  expect({ result, effects: f.effects, state: f.state() }).toMatchObject({
    result: { status: 'partial' },
    effects: ['close'],
    state: { state: 'CLOSED', stateReason: 'COMPLETED' },
  })
})
