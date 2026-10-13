import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ompBuildExtension from '../index'
import { startBootstrap, unbootstrappedWorktree } from '../worktree-entry'

const ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.com',
}

let root: string | undefined

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
})

function fixture(): { repo: string; wt: string; wtGitDir: string } {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'omp-build-entry-')))
  const repo = path.join(root, 'repo')
  mkdirSync(path.join(repo, '.dev'), { recursive: true })
  writeFileSync(path.join(repo, '.dev', 'stack.yml'), 'worktree:\n  copy:\n    - .env\n')
  writeFileSync(path.join(repo, '.env'), 'REAL=1\n')
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env: ENV, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('add', '.dev/stack.yml')
  git('commit', '-q', '-m', 'chore: base')
  const wt = path.join(root, 'wt')
  git('worktree', 'add', '-q', wt, '-b', 'feat/x')
  return { repo, wt, wtGitDir: path.join(repo, '.git', 'worktrees', 'wt') }
}

describe('worktree bootstrap entry', () => {
  it('does not register session or agent start bootstrap handlers', () => {
    const { repo, wt, wtGitDir } = fixture()
    const handlers: Record<string, unknown> = {}
    ompBuildExtension({
      on: (event: string, handler: unknown) => {
        handlers[event] = handler
      },
      registerCommand: () => {},
      sendUserMessage: () => {},
    })

    expect(handlers.session_start).toBeUndefined()
    expect(handlers.agent_start).toBeUndefined()
    expect(existsSync(path.join(wtGitDir, 'omp-build-bootstrap.log'))).toBe(false)
    expect(existsSync(path.join(wtGitDir, 'omp-build-bootstrapped'))).toBe(false)
    expect(existsSync(path.join(wt, '.env'))).toBe(false)
    expect(existsSync(path.join(repo, '.git', 'omp-build-bootstrap.log'))).toBe(false)
  })

  it('still bootstraps when startBootstrap is called explicitly', async () => {
    const { wt, wtGitDir } = fixture()
    const worktree = unbootstrappedWorktree(wt)
    expect(worktree).not.toBeNull()
    startBootstrap(path.resolve(import.meta.dirname, '../../skills/feature/worktree-bootstrap.sh'), worktree!)

    await vi.waitFor(() => expect(existsSync(path.join(wtGitDir, 'omp-build-bootstrapped'))).toBe(true), {
      timeout: 15_000,
      interval: 50,
    })
    expect(readFileSync(path.join(wt, '.env'), 'utf8')).toBe('REAL=1\n')
    expect(readFileSync(path.join(wtGitDir, 'omp-build-bootstrap.log'), 'utf8').trim()).toBe('bootstrap=done')
  })
})
