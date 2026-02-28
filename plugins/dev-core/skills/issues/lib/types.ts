/**
 * Re-export raw types from shared, keep dashboard-specific types local.
 */

export type { RawContent, RawFieldValue, RawItem, RawSubIssue } from '../../shared/types'

export interface Issue {
  number: number
  title: string
  url: string
  status: string
  size: string
  priority: string
  blockStatus: 'ready' | 'blocked' | 'blocking'
  blockedBy: { number: number; state: string }[]
  blocking: { number: number; state: string }[]
  children: Issue[]
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
  state: string
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

export interface DepNode {
  number: number
  title: string
  blockStatus: string
  targets: number[]
}

export interface GraphDims {
  nodeWidth: number
  nodeHeight: number
  hGap: number
  vGap: number
}
