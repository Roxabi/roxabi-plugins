import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runWorktreeBootstrap } from '../../roxabi/workflow-checkout.ts'

const ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
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
  it('bootstraps a linked worktree through the foreground preparation route', async () => {
    const { wt, wtGitDir } = fixture()
    const marker = path.join(wtGitDir, 'omp-build-bootstrapped')
    expect(existsSync(marker)).toBe(false)
    await expect(runWorktreeBootstrap(wt)).resolves.toEqual({ ok: true })
    expect(existsSync(marker)).toBe(true)
    expect(readFileSync(path.join(wt, '.env'), 'utf8')).toBe('REAL=1\n')
  })
})
