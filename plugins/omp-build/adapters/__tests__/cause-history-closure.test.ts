import { describe, expect, it, vi } from 'vitest'
import type { DecodedHistory } from '../../engine/history-schema.ts'
import type { Scope } from '../../engine/record-values.ts'
import { reviewGraph } from '../../testing/record-graphs.ts'
import { history } from '../../testing/record-history.ts'
import { readCauseHistoryClosure } from '../github-workflow/cause-history-closure.ts'
import type { ComposedWorkflowHistory } from '../github-workflow/types.ts'

const scope = (n: number): Scope => ({ repository: 'acme/app', target: `acme/app#${n}` })
const ref = (n: number) => ({ scope: scope(n), recordId: `disposition-${n}`, kind: 'cause-disposition' as const })
function observed(n: number, refs: number[]) {
  const review = reviewGraph({ prefix: `review-${n}`, scope: scope(n) }).review
  const record = { ...review, payload: { ...review.payload, causeDispositionRefs: refs.map(ref) } }
  const base = history([record])
  return { ...base, source: { ...base.source, scope: scope(n) } }
}
function success(histories: DecodedHistory[]): ComposedWorkflowHistory {
  return { ok: true, scopes: histories.map((item) => item.source.scope), histories, records: [] }
}

describe('delivery cause provenance closure', () => {
  it('reads repeated and cyclic references once and reaches a fixed point', async () => {
    const one = observed(1, [2, 2])
    const two = observed(2, [1, 3])
    const three = observed(3, [2])
    const read = vi.fn(async (scopes: readonly Scope[]) =>
      success(scopes.map((item) => (item.target.endsWith('#2') ? two : three))),
    )
    const result = await readCauseHistoryClosure([one], read)
    expect(result.ok && result.histories.map((item) => item.source.scope)).toEqual([scope(1), scope(2), scope(3)])
    expect(read.mock.calls).toEqual([[[scope(2)]], [[scope(3)]]])
  })

  it('retains an unreadable external history diagnostic instead of accepting an empty history', async () => {
    const failure: ComposedWorkflowHistory = {
      ok: false,
      reason: 'unreadable',
      diagnostics: [{ code: 'github-read-failed', message: 'denied' }],
      histories: [],
    }
    const result = await readCauseHistoryClosure([observed(1, [2])], async () => failure)
    expect(result).toMatchObject({ ok: false, reason: 'unreadable', diagnostics: [{ code: 'github-read-failed' }] })
  })

  it('refuses a reader that omits a requested scope', async () => {
    const result = await readCauseHistoryClosure([observed(1, [2])], async () => success([]))
    expect(result).toMatchObject({ ok: false, reason: 'incomplete', diagnostics: [{ code: 'incomplete' }] })
  })
})
