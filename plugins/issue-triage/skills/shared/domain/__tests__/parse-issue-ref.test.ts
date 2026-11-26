import { describe, expect, it, vi } from 'vitest'
import { parseIssueRef, parseIssueRefs } from '../parse-issue-ref'

describe('parseIssueRef', () => {
  it('parses local numbers', () => {
    expect(parseIssueRef('123')).toEqual({ number: 123 })
    expect(parseIssueRef('#123')).toEqual({ number: 123 })
  })

  it('parses owner/repo#N', () => {
    expect(parseIssueRef('Roxabi/lyra#728')).toEqual({ repo: 'Roxabi/lyra', number: 728 })
  })

  it('parses owner/repo.name#N (dots in repo segment)', () => {
    expect(parseIssueRef('Roxabi/docs.site#12')).toEqual({ repo: 'Roxabi/docs.site', number: 12 })
  })

  it('accepts an organization profile repo as a cross-repo issue reference', () => {
    expect(parseIssueRef('github/.github#12')).toEqual({ repo: 'github/.github', number: 12 })
  })

  it.each(['.', '..', '.git', 'x'.repeat(101)])('rejects the invalid repo segment %s', (name) => {
    expect(parseIssueRef(`github/${name}#12`)).toBeUndefined()
  })

  it('rejects incomplete refs', () => {
    expect(parseIssueRef('')).toBeUndefined()
    expect(parseIssueRef('abc')).toBeUndefined()
    expect(parseIssueRef('owner/repo')).toBeUndefined()
  })
})

describe('parseIssueRefs', () => {
  it('skips invalid entries with a warning', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(parseIssueRefs('10,,bad,#11')).toEqual([{ number: 10 }, { number: 11 }])
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })
})
