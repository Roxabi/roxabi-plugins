/**
 * GitWorkspaceAdapter — concrete WorkspacePort backed by git + filesystem.
 */
import type { Branch, Worktree } from '../domain/types'
import type { Workspace, WorkspacePort, WorkspaceProject } from '../ports/workspace'
import {
  discoverProject as discoverProjectFn,
  readWorkspace as readWorkspaceFn,
  writeWorkspace as writeWorkspaceFn,
} from './workspace-helpers'

export class GitWorkspaceAdapter implements WorkspacePort {
  readWorkspace(): Workspace {
    return readWorkspaceFn()
  }

  writeWorkspace(ws: Workspace): void {
    writeWorkspaceFn(ws)
  }

  async discoverProject(repo: string): Promise<WorkspaceProject[]> {
    return discoverProjectFn(repo)
  }

  async listBranches(): Promise<Branch[]> {
    const proc = Bun.spawnSync(['git', 'branch', '--list'], { stdout: 'pipe', stderr: 'pipe' })
    const output = new TextDecoder().decode(proc.stdout).trim()
    if (!output) return []
    return output.split('\n').map((line) => ({
      name: line.replace(/^\*?\s+/, ''),
      isCurrent: line.startsWith('*'),
    }))
  }

  async listWorktrees(): Promise<Worktree[]> {
    const proc = Bun.spawnSync(['git', 'worktree', 'list', '--porcelain'], { stdout: 'pipe', stderr: 'pipe' })
    const output = new TextDecoder().decode(proc.stdout).trim()
    if (!output) return []

    const worktrees: Worktree[] = []
    let current: Partial<Worktree> = {}

    for (const line of output.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (current.path) worktrees.push(current as Worktree)
        current = { path: line.slice(9), isBare: false }
      } else if (line.startsWith('HEAD ')) {
        current.commit = line.slice(5)
      } else if (line.startsWith('branch ')) {
        current.branch = line.slice(7).replace('refs/heads/', '')
      } else if (line === 'bare') {
        current.isBare = true
      }
    }
    if (current.path) worktrees.push(current as Worktree)
    return worktrees
  }
}
