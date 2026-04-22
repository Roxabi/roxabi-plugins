/**
 * Parse issue references — local (#123) or cross-repo (owner/repo#123).
 */

import type { ParsedIssueRef } from './types'

const CROSS_REPO_RE = /^([A-Za-z0-9_-]+\/[A-Za-z0-9_-]+)#(\d+)$/
const LOCAL_RE = /^#?(\d+)$/

/**
 * Parse a single issue reference string.
 *
 * Formats:
 *   - "123" or "#123" → local ref (number only)
 *   - "owner/repo#123" → cross-repo ref (number + repo)
 *
 * Returns undefined for invalid input.
 */
export function parseIssueRef(input: string): ParsedIssueRef | undefined {
  const trimmed = input.trim()

  // Cross-repo: owner/repo#123
  const crossMatch = trimmed.match(CROSS_REPO_RE)
  if (crossMatch) {
    return { repo: crossMatch[1], number: Number(crossMatch[2]) }
  }

  // Local: #123 or 123
  const localMatch = trimmed.match(LOCAL_RE)
  if (localMatch) {
    return { number: Number(localMatch[1]) }
  }

  return undefined
}

/**
 * Parse a comma-separated list of issue references.
 * Skips invalid entries (logs warning to console.error).
 *
 * @example
 *   parseIssueRefs("100, #101, Roxabi/lyra#728")
 *   // → [{ number: 100 }, { number: 101 }, { number: 728, repo: "Roxabi/lyra" }]
 */
export function parseIssueRefs(input: string): ParsedIssueRef[] {
  const refs: ParsedIssueRef[] = []

  for (const part of input.split(',')) {
    const ref = parseIssueRef(part)
    if (ref) {
      refs.push(ref)
    } else {
      console.error(`Warning: Invalid issue reference "${part.trim()}" — skipped`)
    }
  }

  return refs
}
