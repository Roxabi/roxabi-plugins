/** Native creation/revision facts are stamped on first publication; explicit unreadable facts stay unreadable. */
export type Comment = {
  id?: number
  author: string
  body: string
  createdAt?: string | null
  updatedAt?: string | null
}
export type Check = {
  name: string
  status: string
  conclusion: string
  workflowName: string
  startedAt: string
  /** Native GraphQL node id; null preserves an intentional identity gap. */
  id?: string | null
  kind?: 'check-run' | 'status-context'
  context?: string
  state?: string
}
export type Issue = {
  number: number
  title: string
  body: string
  state: 'OPEN' | 'CLOSED'
  author: string
  labels: string[]
  comments: Comment[]
  subIssues: number[]
  blockedBy: number[]
  issueType?: string | null
  updatedAt?: string | null
}
export type Pull = {
  number: number
  title: string
  body: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  headRefName: string
  baseRefName: string
  headRefOid: string
  isCrossRepository: boolean
  labels: string[]
  autoMerge: { enabledAt: string; matchHeadCommit?: string } | null
  mergeCommit: { oid: string; parents: string[] } | null
  mergedAt: string | null
  comments: Comment[]
  lastEditedAt?: string | null
  closes: number[]
  baseRecord?: { at: string; oid: string | null }
}
export type Event = { event: string; label?: { name: string }; created_at: string }
export type State = {
  viewer: string
  owner: string
  name: string
  defaultBranch: string
  /** Bare origin. Merge-on-read runs `git merge --no-ff` into it. */
  origin: string
  repositoryUrls?: Record<string, string>
  requiredChecks: string[]
  nextPr: number
  clock: number
  nextCommentId?: number
  issues: Record<string, Issue>
  prs: Record<string, Pull>
  checks: Record<string, Check[]>
  events: Record<string, Event[]>
  calls: string[][]
  /** Fixture-only; absent pageInfo is unusable to the native CI reader. */
  ciPageInfo?: 'absent'
}

export const CLOSES = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*#(\d+)\b/gi
export const PASSING: Record<string, true> = { success: true, skipped: true, neutral: true }
export const GITHUB_COMMENT_LIMIT = 65536

export class SimError extends Error {}

export function fail(message: string): never {
  throw new SimError(message)
}

export function closesOf(body: string): number[] {
  return [...body.matchAll(CLOSES)].map((match) => Number(match[1]))
}

export function fullName(state: State): string {
  return `${state.owner}/${state.name}`
}

export function stamp(state: State): string {
  const seconds = state.clock
  state.clock += 1
  return new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString().replace('.000Z', 'Z')
}
