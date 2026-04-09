import { run } from '../../shared/adapters/github-adapter'
import type { Branch, Worktree } from './types'

export { run }

export async function fetchBranches(cwd?: string): Promise<Branch[]> {
  try {
    const out = await run(['git', 'branch', '--list'], cwd)
    if (!out) return []
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => ({
        name: line.replace(/^[*+]?\s+/, ''),
        isCurrent: line.startsWith('*'),
      }))
  } catch {
    return []
  }
}

export async function fetchWorktrees(cwd?: string): Promise<Worktree[]> {
  try {
    const out = await run(['git', 'worktree', 'list', '--porcelain'], cwd)
    if (!out) return []
    const trees: Worktree[] = []
    let current: Partial<Worktree> = {}
    for (const line of out.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (current.path) trees.push(current as Worktree)
        current = { path: line.slice(9), branch: '', commit: '', isBare: false }
      } else if (line.startsWith('HEAD ')) {
        current.commit = line.slice(5, 12)
      } else if (line.startsWith('branch ')) {
        current.branch = line.slice(7).replace('refs/heads/', '')
      } else if (line === 'bare') {
        current.isBare = true
      }
    }
    if (current.path) trees.push(current as Worktree)
    return trees
  } catch {
    return []
  }
}
