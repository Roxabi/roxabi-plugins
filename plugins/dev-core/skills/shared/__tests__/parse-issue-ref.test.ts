import { describe, expect, it, vi } from 'vitest'

import { parseIssueRef, parseIssueRefs } from '../domain/parse-issue-ref'

describe('parseIssueRef', () => {
  it('parses local numeric reference', () => {
    expect(parseIssueRef('123')).toEqual({ number: 123 })
  })

  it('parses local reference with # prefix', () => {
    expect(parseIssueRef('#123')).toEqual({ number: 123 })
  })

  it('parses cross-repo reference', () => {
    expect(parseIssueRef('Roxabi/lyra#728')).toEqual({ repo: 'Roxabi/lyra', number: 728 })
  })

  it('parses cross-repo with hyphenated names', () => {
    expect(parseIssueRef('my-org/my-repo-name#42')).toEqual({ repo: 'my-org/my-repo-name', number: 42 })
  })

  it('trims whitespace', () => {
    expect(parseIssueRef('  #123  ')).toEqual({ number: 123 })
    expect(parseIssueRef('  Roxabi/lyra#728  ')).toEqual({ repo: 'Roxabi/lyra', number: 728 })
  })

  it('returns undefined for invalid input', () => {
    expect(parseIssueRef('')).toBeUndefined()
    expect(parseIssueRef('abc')).toBeUndefined()
    expect(parseIssueRef('owner/#123')).toBeUndefined()
    expect(parseIssueRef('/repo#123')).toBeUndefined()
  })
})

describe('parseIssueRefs', () => {
  it('parses comma-separated local refs', () => {
    expect(parseIssueRefs('100,101,102')).toEqual([
      { number: 100 },
      { number: 101 },
      { number: 102 },
    ])
  })

  it('parses mixed local and cross-repo refs', () => {
    expect(parseIssueRefs('100, #101, Roxabi/lyra#728')).toEqual([
      { number: 100 },
      { number: 101 },
      { repo: 'Roxabi/lyra', number: 728 },
    ])
  })

  it('skips invalid entries and logs warning', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = parseIssueRefs('100, invalid, 101')
    expect(result).toEqual([{ number: 100 }, { number: 101 }])
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid issue reference'))
    errSpy.mockRestore()
  })

  it('handles empty string', () => {
    expect(parseIssueRefs('')).toEqual([])
  })
})
