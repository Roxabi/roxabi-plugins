/**
 * closing-issues.ts — extract GitHub closing keywords for /promote PR body
 *
 * Feature PRs merge into `staging` with `Closes #N`, but GitHub only auto-closes
 * when the PR that carries the keyword merges into the **default branch**.
 * Promote re-emits those keywords on the staging→main PR so merge to main closes them.
 *
 * Keywords (GitHub docs): close[sd]?, fix(e[sd])?, resolve[sd]?
 * Bare `(#N)` in titles is NOT a closing keyword — ignored here.
 */

/** Match GitHub auto-close keywords → issue number. */
export const CLOSING_KEYWORD_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi

/**
 * Extract unique issue numbers referenced by closing keywords in free text
 * (PR body, commit message). Sorted ascending.
 */
export function extractClosingIssueNumbers(text: string): number[] {
  if (!text) return []
  const nums = new Set<number>()
  // reset lastIndex for global regex reuse
  CLOSING_KEYWORD_RE.lastIndex = 0
  for (const m of text.matchAll(CLOSING_KEYWORD_RE)) {
    const n = Number.parseInt(m[1] ?? '', 10)
    if (Number.isFinite(n) && n > 0) nums.add(n)
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
 * Returns PR numbers (not issue numbers).
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
