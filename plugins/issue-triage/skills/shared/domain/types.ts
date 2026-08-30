/**
 * Dev-core domain types — replaces ad-hoc inline types across skills.
 * These are the canonical representations of GitHub entities within dev-core.
 */

export interface SubIssue {
  number: number
  state: string
  title: string
}

export interface BlockRef {
  number: number
  state: string
}

export interface Issue {
  number: number
  title: string
  url: string
  state: string
  status: string
  size: string | null
  priority: string | null
  labels: string[]
  assignees: string[]
  children: SubIssue[]
  blockStatus?: 'ready' | 'blocked' | 'blocking'
  blockedBy?: BlockRef[]
  blocking?: BlockRef[]
  projectLabel?: string
}

export interface CICheck {
  name: string
  status: string
  conclusion: string
  detailsUrl: string
}

export interface PR {
  number: number
  title: string
  branch: string
  state: string
  isDraft: boolean
  url: string
  author: string
  updatedAt: string
  additions: number
  deletions: number
  reviewDecision: string
  labels: string[]
  mergeable: string
  checks: CICheck[]
}

export interface Project {
  id: string
  title: string
  repo: string
}

export interface Branch {
  name: string
  isCurrent: boolean
}

export interface Worktree {
  path: string
  branch: string
  commit: string
  isBare: boolean
}

export interface BuildStep {
  name: string
  status: 'done' | 'running' | 'pending' | 'error'
}

export interface VercelDeployment {
  uid: string
  url: string
  name: string
  state: string
  isCurrent?: boolean
  target: string
  createdAt: number
  buildingAt: number
  ready: number
  source: string
  meta: { githubCommitRef?: string; githubCommitMessage?: string }
  inspectorUrl: string
  buildSteps: BuildStep[]
}

export interface BranchCI {
  branch: string
  commitSha: string
  commitMessage: string
  committedAt: string
  overallState: string
  checks: CICheck[]
}

export interface WorkflowRun {
  id: number
  name: string
  displayTitle: string
  event: string
  status: string
  conclusion: string | null
  htmlUrl: string
  createdAt: string
  updatedAt: string
  headBranch: string
  headCommitMessage: string
}

export interface ProjectFieldIds {
  status?: string
  col2?: string
  col3?: string
  statusOptions?: Record<string, string>
  col2Options?: Record<string, string>
  col3Options?: Record<string, string>
}

/** Parsed issue reference — local (#123) or cross-repo (owner/repo#123). */
export interface ParsedIssueRef {
  number: number
  /** Undefined for local refs (use default repo). */
  repo?: string
}
