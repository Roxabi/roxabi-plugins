/** File contents by path; `null` deletes (a directory recursively). */
export type Files = Record<string, string | null>
export type Commit = { message: string; files: Files }
export type BranchSpec = { name: string; from: string; commits: Commit[] }
/** `base` is the PR's base branch (`main` when omitted). */
export type PrSpec = { number: number; branch: string; title: string; body: string; closes: number[]; base?: string }
export type IssueSpec = { number: number; title: string; issueType?: string | null }
export type Spec = {
  base: Files
  /** Side refs pushed to origin (`refs/heads/<name>`), e.g. a neutral revision. */
  branches: BranchSpec[]
  issues: IssueSpec[]
  prs: PrSpec[]
  /** The principal checkout's directory name; trailing whitespace is kept. */
  principalName?: string
  /** Files written into the principal checkout and never committed (the operator's ignored state). */
  principalFiles?: Record<string, string>
  /** Extra PATH entries before the simulator's bin. */
  path?: string[]
}

type SimComment = { id?: number; author: string; body: string; createdAt?: string | null; updatedAt?: string | null }
type SimPull = {
  number: number
  body: string
  state: string
  headRefName: string
  headRefOid: string
  baseRefName: string
  labels: string[]
  autoMerge: { enabledAt: string; matchHeadCommit?: string } | null
  comments: SimComment[]
  lastEditedAt?: string | null
  closes: number[]
  /** GitHub's recorded `baseRefOid`, keyed by the `<base>@<head>` it was recorded for. */
  baseRecord?: { at: string; oid: string | null }
  mergeCommit?: { oid: string; parents: string[] } | null
  mergedAt?: string | null
}
export type SimIssue = {
  number: number
  title: string
  body: string
  state: 'OPEN' | 'CLOSED'
  author: string
  labels: string[]
  comments: SimComment[]
  subIssues: number[]
  blockedBy: number[]
  issueType?: string | null
  updatedAt?: string | null
}
export type SimState = {
  viewer: string
  repositoryUrls?: Record<string, string>
  prs: Record<string, SimPull>
  issues: Record<string, SimIssue>
  checks: Record<
    string,
    { name: string; status: string; conclusion: string; workflowName: string; startedAt: string }[]
  >
  calls: string[][]
}

export type Box = {
  root: string
  origin: string
  principal: string
  stateFile: string
  env: NodeJS.ProcessEnv
  /** Tip of every branch, `main` included. */
  sha: Record<string, string>
}
