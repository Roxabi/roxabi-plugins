/**
 * Re-export raw types from shared, keep dashboard-specific types local.
 */

import type { WorkspaceProject } from '../../shared/ports/workspace'

export type { RawContent, RawFieldValue, RawItem, RawSubIssue } from '../../shared/types'
// re-export to expose gh-enums types to this module's consumers; import for local use in interface bodies below
export type {
  CheckConclusionState,
  CheckStatusState,
  MergeableState,
  PullRequestState,
  StatusState,
  VercelState,
  WorkflowConclusion,
  WorkflowStatus,
} from './gh-enums'
export type { WorkspaceProject }

import type {
  CheckConclusionState,
  CheckStatusState,
  MergeableState,
  PullRequestState,
  StatusState,
  VercelState,
  WorkflowConclusion,
  WorkflowStatus,
} from './gh-enums'

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
  projectLabel?: string
  inProjects?: string[]
}

export interface CICheck {
  name: string
  status: CheckStatusState | StatusState | ''
  conclusion: CheckConclusionState | ''
  detailsUrl: string
}

export interface PR {
  number: number
  title: string
  branch: string
  state: PullRequestState | ''
  isDraft: boolean
  url: string
  author: string
  updatedAt: string
  additions: number
  deletions: number
  reviewDecision: string
  labels: string[]
  mergeable: MergeableState
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
  name: string
  state: VercelState
  isCurrent?: boolean // true for the active production deployment
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
  status: WorkflowStatus | ''
  conclusion: WorkflowConclusion | null
  htmlUrl: string
  createdAt: string
  updatedAt: string
  headBranch: string
  headCommitMessage: string
}

export type ProjectMeta = {
  prs: PR[]
  branchCI: BranchCI[]
  workflowRuns: WorkflowRun[]
  deployments: VercelDeployment[]
  branches: Branch[]
  worktrees: Worktree[]
}

export interface DashboardProps {
  issues: Issue[]
  prs: PR[]
  branches: Branch[]
  worktrees: Worktree[]
  deployments: VercelDeployment[]
  branchCI: BranchCI[]
  workflowRuns: WorkflowRun[]
  fetchMs: number
  updatedAt: number
  byProject?: Map<string, Issue[]>
  workspaceProjects?: WorkspaceProject[]
  byProjectMeta?: Map<string, ProjectMeta>
  roadmapItems?: Issue[]
  roadmapProject?: { label: string; projectId: string }
  truncatedProjects?: string[]
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
