/**
 * closing-issues.ts — extract GitHub closing keywords for /promote PR body
 *
 * Feature PRs merge into `staging` with `Closes #N`, but GitHub only auto-closes
 * when the PR that carries the keyword merges into the **default branch**.
 * Promote re-emits those keywords on the staging→main PR so merge to main closes them.
 *
 * Keywords (GitHub docs): close[sd]?, fix(e[sd])?, resolve[sd]?
 * Bare `(#N)` in titles is NOT a closing keyword — ignored here.
 *
 * Multi-ref: `Closes #10, #11` / `Fixes #1 and #2` → all numbers on that keyword line.
 * This module is the **SSOT** for extract/format — collect-closing-issues.sh pipes
 * harvested text here via closing-issues-cli.ts (do not reimplement regex in bash).
 */

/** Keyword at start of a closing phrase (optional colon). */
const KEYWORD_PREFIX_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*/gi

/**
 * Extract unique issue numbers referenced by closing keywords in free text
 * (PR body, commit message). Sorted ascending.
 *
 * Scans each keyword occurrence, then takes every `#N` on the remainder of that line
 * (GitHub multi-ref form).
 */
export function extractClosingIssueNumbers(text: string): number[] {
  if (!text) return []
  const nums = new Set<number>()
  for (const line of text.split(/\r?\n/)) {
    KEYWORD_PREFIX_RE.lastIndex = 0
    let m: RegExpExecArray | null = KEYWORD_PREFIX_RE.exec(line)
    while (m !== null) {
      const rest = line.slice(m.index + m[0].length)
      for (const hm of rest.matchAll(/#(\d+)\b/g)) {
        const n = Number.parseInt(hm[1] ?? '', 10)
        if (Number.isFinite(n) && n > 0) nums.add(n)
      }
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
    'Re-emitted from feature PR / commit closing keywords. GitHub auto-closes',
    'these when this PR merges into the default branch (`main`):',
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
