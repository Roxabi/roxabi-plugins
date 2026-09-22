import { describe, expect, it } from 'vitest'

import { resolvePriority } from '../adapters/config-helpers'

describe('issue-triage/shared > resolvePriority', () => {
  it('accepts the canonical value and the short and word aliases', () => {
    expect(resolvePriority('P3 - Low')).toBe('P3 - Low')
    expect(resolvePriority('P3')).toBe('P3 - Low')
    expect(resolvePriority('low')).toBe('P3 - Low')
  })

  it('accepts the label spelling the CLI writes and gh displays', () => {
    // #525: `P3-low` is the string `gh issue view` and `gh label list` show —
    // and it was the one spelling the flag rejected.
    expect(resolvePriority('P3-low')).toBe('P3 - Low')
    expect(resolvePriority('p3_low')).toBe('P3 - Low')
    expect(resolvePriority('P0-critical')).toBe('P0 - Urgent')
    expect(resolvePriority('P1-High')).toBe('P1 - High')
  })

  it('tolerates separator and case drift on the canonical value', () => {
    expect(resolvePriority('p2 - medium')).toBe('P2 - Medium')
    expect(resolvePriority('P2-Medium')).toBe('P2 - Medium')
  })

  it('returns undefined for a value it cannot canonicalise', () => {
    expect(resolvePriority('P4')).toBeUndefined()
    expect(resolvePriority('lowish')).toBeUndefined()
    expect(resolvePriority('')).toBeUndefined()
  })
})
