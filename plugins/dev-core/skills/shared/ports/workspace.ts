/**
 * WorkspacePort — role interface for workspace/worktree/git operations.
 */
import type { Branch, Worktree } from '../domain/types'

export interface WorkspaceProject {
  repo: string
  projectId: string
  label: string
  type?: 'technical' | 'company'
  fieldIds?: import('../domain/types').ProjectFieldIds
  vercelProjectId?: string
  vercelTeamId?: string
}

export interface Workspace {
  projects: WorkspaceProject[]
}

export interface WorkspacePort {
  readWorkspace(): Workspace
  writeWorkspace(ws: Workspace): void
  discoverProject(repo: string): Promise<WorkspaceProject[]>
  listBranches(): Promise<Branch[]>
  listWorktrees(): Promise<Worktree[]>
  run(cmd: string[]): Promise<string>
}
