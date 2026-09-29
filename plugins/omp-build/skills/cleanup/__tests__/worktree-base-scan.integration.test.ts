import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const SCAN = path.resolve(import.meta.dirname, '..', 'scan-orphan-worktree-shells.sh')
const ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
}

let root: string | undefined

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
})

describe('OMP worktree base orphan scan', () => {
  it('reports a shell under this repo and never another repository', () => {
    root = mkdtempSync(path.join(tmpdir(), 'omp-build-wt-scan-'))
    const repo = path.join(root, 'repo')
    const home = path.join(root, 'home')
    const base = path.join(root, 'wt-base')
    mkdirSync(repo)
    mkdirSync(home)
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env: ENV, stdio: 'ignore' })
    writeFileSync(path.join(repo, 'README.md'), 'base\n')
    execFileSync('git', ['add', 'README.md'], { cwd: repo, env: ENV, stdio: 'ignore' })
    execFileSync('git', ['commit', '-q', '-m', 'chore: base'], {
      cwd: repo,
      env: {
        ...ENV,
        GIT_AUTHOR_NAME: 'Fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.com',
        GIT_COMMITTER_NAME: 'Fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.com',
      },
      stdio: 'ignore',
    })
    const ours = path.join(base, 'repo', 'feat-orphan')
    const theirs = path.join(base, 'other-repo', 'secret')
    mkdirSync(path.join(ours, 'node_modules'), { recursive: true })
    mkdirSync(path.join(theirs, 'node_modules'), { recursive: true })
    const out = execFileSync('bash', [SCAN], {
      cwd: repo,
      env: { ...ENV, HOME: home, OMP_WORKTREE_DIR: base },
      encoding: 'utf8',
    })
    expect(out).toContain(ours)
    expect(out).not.toContain('other-repo')
    expect(out).not.toContain(theirs)
  })
})
