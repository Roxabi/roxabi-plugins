/**
 * Legacy label migration for `init`. Pure: no GitHub, no filesystem.
 *
 * Unknown spellings are untouched. A label that is already the canonical
 * target is not removed. Nothing here deletes a repository label definition.
 */

export const CANONICAL_LABELS = [
  'size:S',
  'size:F-lite',
  'size:F-full',
  'P0-critical',
  'P1-high',
  'P2-medium',
  'P3-low',
  'reviewed',
  'epic',
] as const

const SIZE_VALUE: Record<string, string> = {
  xs: 'size:S',
  s: 'size:S',
  m: 'size:F-lite',
  l: 'size:F-full',
  xl: 'size:F-full',
}

const PRIORITY_VALUE: Record<string, string> = {
  urgent: 'P0-critical',
  critical: 'P0-critical',
  high: 'P1-high',
  medium: 'P2-medium',
  low: 'P3-low',
}

export interface LabelMove {
  /** Canonical label to add, or null when the only action is a removal. */
  add: string | null
  /** True when the legacy spelling itself must come off the issue. */
  remove: boolean
}

/** One legacy spelling → its move. Unknown → untouched (`add: null, remove: false`). */
export function migrateLabel(name: string): LabelMove {
  const trimmed = name.trim()
  if (/^ready-for-agent$/i.test(trimmed)) return { add: null, remove: true }

  const size = /^(size)\s*:\s*(.+)$/i.exec(trimmed)
  if (size) {
    const to = SIZE_VALUE[size[2].trim().toLowerCase()]
    if (!to || to === trimmed) return { add: null, remove: false }
    return { add: to, remove: true }
  }

  const priority = /^(priority)\s*:\s*(.+)$/i.exec(trimmed)
  if (priority) {
    const to = PRIORITY_VALUE[priority[2].trim().toLowerCase()]
    if (!to || to === trimmed) return { add: null, remove: false }
    return { add: to, remove: true }
  }

  return { add: null, remove: false }
}

export interface IssueLabels {
  number: number
  labels: string[]
  body?: string
}

export interface IssueRelabel {
  number: number
  add: string[]
  remove: string[]
}

export function planIssue(labels: string[]): { add: string[]; remove: string[] } {
  const have = new Set(labels)
  const add = new Set<string>()
  const remove = new Set<string>()
  for (const label of labels) {
    const move = migrateLabel(label)
    if (move.remove) remove.add(label)
    if (move.add && !have.has(move.add)) add.add(move.add)
  }
  return { add: [...add], remove: [...remove] }
}

export function planRelabels(issues: IssueLabels[]): IssueRelabel[] {
  const out: IssueRelabel[] = []
  for (const issue of issues) {
    const move = planIssue(issue.labels)
    if (move.add.length === 0 && move.remove.length === 0) continue
    out.push({ number: issue.number, ...move })
  }
  return out
}

/** Apply a plan in memory. Used to prove a second run is empty. */
export function applyRelabels(issues: IssueLabels[], relabels: IssueRelabel[]): IssueLabels[] {
  const byNumber = new Map(relabels.map((row) => [row.number, row]))
  return issues.map((issue) => {
    const move = byNumber.get(issue.number)
    if (!move) return issue
    const remove = new Set(move.remove)
    const labels = [...issue.labels.filter((label) => !remove.has(label)), ...move.add]
    return { ...issue, labels }
  })
}

export function missingCanonical(existing: string[]): string[] {
  const have = new Set(existing)
  return CANONICAL_LABELS.filter((name) => !have.has(name))
}

const BLOCKED_BY_PROSE = /(?:^|\n)\s*blocked by\s*:/i

/** Issue numbers whose body contains a prose `Blocked by:` line. Report only. */
export function proseBlockedBy(issues: IssueLabels[]): number[] {
  return issues.filter((issue) => issue.body && BLOCKED_BY_PROSE.test(issue.body)).map((issue) => issue.number)
}
