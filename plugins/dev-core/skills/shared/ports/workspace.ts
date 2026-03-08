/**
 * WorkspacePort — role interface for workspace/worktree/git operations.
 */
import type { Branch, ProjectFieldIds, Worktree } from '../domain/types'

export interface VercelProjectRef {
  projectId: string
  teamId: string
}

export interface WorkspaceProject {
  repo: string
  projectId: string
  label: string
  type?: 'technical' | 'company'
  fieldIds?: ProjectFieldIds
  vercelProjects?: VercelProjectRef[]
  localPath?: string
}

export type ProjectType = 'technical' | 'company'

export interface Workspace {
  projects: WorkspaceProject[]
  roadmapProjectId?: string
}

export interface WorkspacePort {
  readWorkspace(): Workspace
  writeWorkspace(ws: Workspace): void
  discoverProject(repo: string): Promise<WorkspaceProject[]>
  listBranches(): Promise<Branch[]>
  listWorktrees(): Promise<Worktree[]>
}
