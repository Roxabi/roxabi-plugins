/**
 * closing-issues.ts — extract GitHub closing keywords for /R-promote PR body
 *
 * Feature PRs merge into `staging` with `Closes #N`, but GitHub only auto-closes
 * when the PR that carries the keyword merges into the **default branch**.
 * Promote re-emits those keywords on the staging→main PR so merge to main closes them.
 *
 * Keywords (GitHub docs): close[sd]?, fix(e[sd])?, resolve[sd]?
 * Bare `(#N)` in titles is NOT a closing keyword — ignored here.
 *
 * Multi-ref (adjacency only): `Closes #10, #11` / `Fixes #1 and #2`.
 * Does NOT harvest distant `#N` after prose (`we will fix this after #99`).
 * Cross-repo `owner/repo#N` is skipped (re-emit is same-repo only).
 *
 * This module is the **SSOT** for extract/format — collect-closing-issues.sh pipes
 * harvested text here via closing-issues-cli.ts.
 */

/** Keyword at start of a closing phrase (optional colon). */
const KEYWORD_PREFIX_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*/gi

/** Leading separators between issue refs on a keyword line. */
const SEP_RE = /^(?:,|and|&)\s*/i

/** Same-repo `#N`. */
const LOCAL_REF_RE = /^#(\d+)\b/

/** Cross-repo `owner/repo#N` — skipped for promote re-emit. */
const CROSS_REF_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#(\d+)\b/

/**
 * After a closing keyword, parse only the contiguous ref list (GitHub grammar).
 * Stops at the first non-ref token so prose `#N` later on the line is ignored.
 * Cross-repo refs are consumed but not added (same-repo re-emit only).
 */
export function parseClosingRefList(rest: string): number[] {
  const nums: number[] = []
  let pos = 0
  const s = rest
  // Allow leading whitespace only (already often consumed by keyword regex)
  const lead = s.match(/^\s*/)
  if (lead) pos += lead[0].length

  let expectSep = false
  while (pos < s.length) {
    if (expectSep) {
      const sep = s.slice(pos).match(SEP_RE)
      if (!sep) break
      pos += sep[0].length
      const sp = s.slice(pos).match(/^\s*/)
      if (sp) pos += sp[0].length
    }

    const cross = s.slice(pos).match(CROSS_REF_RE)
    if (cross) {
      pos += cross[0].length
      expectSep = true
      const trail = s.slice(pos).match(/^\s*/)
      if (trail) pos += trail[0].length
      continue
    }

    const local = s.slice(pos).match(LOCAL_REF_RE)
    if (local) {
      const n = Number.parseInt(local[1] ?? '', 10)
      if (Number.isFinite(n) && n > 0) nums.push(n)
      pos += local[0].length
      expectSep = true
      const trail = s.slice(pos).match(/^\s*/)
      if (trail) pos += trail[0].length
      continue
    }

    break
  }
  return nums
}

/**
 * Extract unique issue numbers referenced by closing keywords in free text
 * (PR body, commit message). Sorted ascending.
 */
export function extractClosingIssueNumbers(text: string): number[] {
  if (!text) return []
  const nums = new Set<number>()
  for (const line of text.split(/\r?\n/)) {
    KEYWORD_PREFIX_RE.lastIndex = 0
    let m: RegExpExecArray | null = KEYWORD_PREFIX_RE.exec(line)
    while (m !== null) {
      const rest = line.slice(m.index + m[0].length)
      for (const n of parseClosingRefList(rest)) nums.add(n)
      m = KEYWORD_PREFIX_RE.exec(line)
    }
  }
  return [...nums].sort((a, b) => a - b)
}

/** Union of extractClosingIssueNumbers over many texts. */
export function collectClosingIssueNumbers(texts: Iterable<string>): number[] {
  const nums = new Set<number>()
  for (const t of texts) {
    for (const n of extractClosingIssueNumbers(t)) nums.add(n)
  }
  return [...nums].sort((a, b) => a - b)
}

/**
 * Markdown section for the promote PR body.
 * Empty string when no issues — omit section entirely.
 */
export function formatClosesSection(issueNumbers: number[]): string {
  if (issueNumbers.length === 0) return ''
  const lines = [
    '## Issues closed by this promote',
    '',
    'Re-emitted from feature PR / commit closing keywords (same-repo, open at harvest).',
    'GitHub auto-closes these when this PR merges into the default branch (`main`).',
    'Review this list before merge — harvest is best-effort.',
    '',
    ...issueNumbers.map((n) => `Closes #${n}`),
    '',
  ]
  return lines.join('\n')
}

/**
 * Parse "Merge pull request #N" subjects from merge-commit subjects.
 * Returns PR numbers (not issue numbers). Fallback when `gh pr list` unavailable.
 */
export function extractMergedPrNumbersFromSubjects(subjects: Iterable<string>): number[] {
  const re = /^Merge pull request #(\d+)\b/i
  const nums = new Set<number>()
  for (const s of subjects) {
    const m = s.trim().match(re)
    if (!m) continue
    const n = Number.parseInt(m[1] ?? '', 10)
    if (Number.isFinite(n) && n > 0) nums.add(n)
  }
  return [...nums].sort((a, b) => a - b)
}

/** Format issue list as JSON. */
export function formatIssuesJson(issueNumbers: number[]): string {
  return JSON.stringify({ issues: issueNumbers })
}
