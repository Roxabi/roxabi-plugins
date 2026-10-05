import { execFileSync, spawn } from 'node:child_process'
import { closeSync, existsSync, openSync } from 'node:fs'
import { join } from 'node:path'

export type LinkedWorktree = { top: string; gitDir: string }

/**
 * The linked worktree holding `cwd` when it was never bootstrapped, else null:
 * the principal (its git dir is the common dir), a directory outside git, and a
 * worktree carrying `omp-build-bootstrapped` all yield null.
 */
export function unbootstrappedWorktree(cwd: string): LinkedWorktree | null {
  let out: string
  try {
    out = execFileSync(
      'git',
      ['-C', cwd, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
  } catch {
    return null
  }
  const [top, gitDir, commonDir] = out.trim().split('\n')
  if (!top || !gitDir || gitDir === commonDir) return null
  if (existsSync(join(gitDir, 'omp-build-bootstrapped'))) return null
  return { top, gitDir }
}

/**
 * Runs `script` at the worktree root, detached from the session, appending its
 * output to `<git dir>/omp-build-bootstrap.log`.
 */
export function startBootstrap(script: string, worktree: LinkedWorktree): void {
  const log = openSync(join(worktree.gitDir, 'omp-build-bootstrap.log'), 'a')
  try {
    const child = spawn('bash', [script], { cwd: worktree.top, detached: true, stdio: ['ignore', log, log] })
    child.on('error', () => {})
    child.unref()
  } finally {
    closeSync(log)
  }
}
