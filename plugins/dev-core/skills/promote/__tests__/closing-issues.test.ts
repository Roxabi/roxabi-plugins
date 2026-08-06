import { describe, expect, it } from 'vitest'
import {
  collectClosingIssueNumbers,
  extractClosingIssueNumbers,
  extractMergedPrNumbersFromSubjects,
  formatClosesSection,
  formatIssuesJson,
} from '../lib/closing-issues'

describe('extractClosingIssueNumbers', () => {
  it('extracts Closes / Fixes / Resolves variants', () => {
    const text = `
      Closes #135
      fixes #10
      Fixed #11
      resolve #12
      Resolved #13
      close #14
      closed #15
    `
    expect(extractClosingIssueNumbers(text)).toEqual([10, 11, 12, 13, 14, 15, 135])
  })

  it('dedupes and sorts', () => {
    expect(extractClosingIssueNumbers('Closes #3\nCloses #1\nFixes #3')).toEqual([1, 3])
  })

  it('ignores bare (#N) titles and Refs', () => {
    expect(extractClosingIssueNumbers('feat(api): images (#135)\nRefs #99\nSee #42')).toEqual([])
  })

  it('returns [] for empty', () => {
    expect(extractClosingIssueNumbers('')).toEqual([])
    expect(extractClosingIssueNumbers('no keywords')).toEqual([])
  })

  it('extracts multi-ref on one keyword line', () => {
    expect(extractClosingIssueNumbers('Closes #10, #11, #12')).toEqual([10, 11, 12])
    expect(extractClosingIssueNumbers('Fixes #1 and #2')).toEqual([1, 2])
  })

  it('accepts optional colon after keyword', () => {
    expect(extractClosingIssueNumbers('Closes: #42')).toEqual([42])
  })

  it('is case-insensitive for keyword', () => {
    expect(extractClosingIssueNumbers('CLOSES #7\nFIXES #8')).toEqual([7, 8])
  })
})

describe('collectClosingIssueNumbers', () => {
  it('unions texts', () => {
    expect(collectClosingIssueNumbers(['Closes #1', 'Fixes #2\nCloses #1'])).toEqual([1, 2])
  })
})

describe('formatClosesSection', () => {
  it('returns empty when no issues', () => {
    expect(formatClosesSection([])).toBe('')
  })

  it('emits one Closes line per issue', () => {
    const md = formatClosesSection([135, 140])
    expect(md).toContain('## Issues closed by this promote')
    expect(md).toContain('Closes #135')
    expect(md).toContain('Closes #140')
    expect(md.match(/^Closes #\d+$/gm)).toEqual(['Closes #135', 'Closes #140'])
  })
})

describe('formatIssuesJson', () => {
  it('wraps array', () => {
    expect(formatIssuesJson([1, 2])).toBe('{"issues":[1,2]}')
    expect(formatIssuesJson([])).toBe('{"issues":[]}')
  })
})

describe('extractMergedPrNumbersFromSubjects', () => {
  it('parses merge commit subjects', () => {
    expect(
      extractMergedPrNumbersFromSubjects([
        'Merge pull request #136 from go-silex/feat/135-pat-ticket-images',
        'Merge pull request #142 from go-silex/staging',
        'feat: not a merge',
      ]),
    ).toEqual([136, 142])
  })
})
