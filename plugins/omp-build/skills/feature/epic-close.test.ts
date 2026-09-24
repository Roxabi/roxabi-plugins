import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { epicDiffRange, postMergeHook } from './epic-close'

describe('epic close', () => {
  it('computes the cumulative range from the merged children', () => {
    expect(
      epicDiffRange([
        { number: 1, baseSha: 'base1', mergeSha: 'm1' },
        { number: 2, baseSha: 'base2', mergeSha: null },
        { number: 3, baseSha: 'base3', mergeSha: 'm3' },
      ]),
    ).toEqual({ range: 'base1..m3' })
  })

  it('refuses a range when nothing has merged', () => {
    expect(epicDiffRange([{ number: 1, baseSha: 'base1', mergeSha: null }])).toEqual({
      error: 'no merged children',
    })
  })

  it('skips the hook when release.post_merge is absent and says so', () => {
    expect(postMergeHook(null)).toEqual({ skip: 'no release.post_merge — hook skipped' })
    expect(postMergeHook('  ')).toEqual({ skip: 'no release.post_merge — hook skipped' })
    expect(postMergeHook('make smoke')).toEqual({ run: 'make smoke' })
  })

  it('states the final review and the hook as epic completion conditions', () => {
    const skill = readFileSync(fileURLToPath(new URL('./SKILL.md', import.meta.url)), 'utf-8')
    expect(skill).toContain('final epic review')
    expect(skill).toContain('release.post_merge')
    expect(skill).toContain('goal drop')
  })
})
