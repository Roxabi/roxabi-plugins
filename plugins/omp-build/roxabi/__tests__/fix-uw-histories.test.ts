import { expect, it } from 'vitest'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { mergeFixUwHistories } from '../fix-uw-histories.ts'

it('retains one complete observation per scope and rejects conflicting or incomplete observations', () => {
  const fixtures = roxabiWorkflowFixtures()
  const scope = { repository: 'acme/app', target: 'acme/app#42' }
  const original = fixtures.historyFrom([fixtures.featureMandate(scope)])
  const clone = structuredClone(original)
  const merged = mergeFixUwHistories([original], [clone])
  expect(merged.ok).toBe(true)
  if (merged.ok) expect(merged.value).toEqual([original])
  const conflicting = { ...clone, source: { ...clone.source, expectedAuthor: 'different' } }
  expect(mergeFixUwHistories([original], [conflicting])).toMatchObject({
    ok: false,
    diagnostics: expect.arrayContaining(['fix-history-observation-drift']),
  })
  const incomplete = { ...clone, source: { ...clone.source, complete: false } }
  expect(mergeFixUwHistories([], [incomplete])).toMatchObject({
    ok: false,
    diagnostics: expect.arrayContaining(['fix-history-observation-drift']),
  })
})
