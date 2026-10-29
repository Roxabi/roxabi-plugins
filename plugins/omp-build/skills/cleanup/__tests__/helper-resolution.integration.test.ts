import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Cleanup uses the shared base-selection behavior and protects the principal.
 *
 * Integration, not unit: every probe here forks bash or git, and vitest.setup.ts
 * fails a unit test that forks (#502).
 */
const SKILLS = path.resolve(import.meta.dirname, '..', '..')
const ANALYZE = path.join(SKILLS, 'cleanup', 'analyze-branches.sh')

/**
 * Git reads GIT_DIR / GIT_WORK_TREE from the environment and they beat `cwd`.
 * Under a git hook — lefthook runs this suite on pre-push — they point at
 * whatever repository invoked the hook, so a probe would answer about the wrong
 * one (#532). Strip them, then force a fixture identity on top.
 */
const FIXTURE_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.com',
}

/** A throwaway repo with `origin/staging` and `origin/main` as remote-tracking refs. */
function fixtureRepo(bases: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'omp-build-tail-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env: FIXTURE_ENV, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('commit', '-q', '--allow-empty', '-m', 'root')
  for (const base of bases) git('update-ref', `refs/remotes/origin/${base}`, 'HEAD')
  return dir
}

describe('cleanup shared-helper behavior', () => {
  it('uses the sourced detect_base_branch to pick the base', () => {
    // With both remote bases present the report must name `staging`; with
    // neither it must fall back to `main`, exercising the shared helper.
    for (const [bases, expected] of [
      [['staging', 'main'], 'staging'],
      [[], 'main'],
    ] as const) {
      const dir = fixtureRepo([...bases])
      try {
        const out = execFileSync('bash', [ANALYZE, '--json', '--no-fetch'], {
          cwd: dir,
          env: FIXTURE_ENV,
          encoding: 'utf8',
        })
        expect(JSON.parse(out).base_branch).toBe(expected)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })
})

describe('analyze-branches.sh cannot act on the principal', () => {
  /** Principal on `main`, a linked worktree on a merged feature branch. */
  function principalAndWorktree(): { principal: string; linked: string } {
    const root = mkdtempSync(path.join(tmpdir(), 'omp-build-principal-'))
    const principal = path.join(root, 'repo')
    const linked = path.join(root, 'wt')
    mkdirSync(principal)
    const git = (...args: string[]) => execFileSync('git', args, { cwd: principal, env: FIXTURE_ENV, stdio: 'ignore' })
    git('init', '-q', '-b', 'main')
    writeFileSync(path.join(principal, 'README.md'), 'base\n')
    git('add', 'README.md')
    git('commit', '-q', '-m', 'chore: base')
    git('checkout', '-q', '-b', 'feat/19-auth')
    git('commit', '-q', '--allow-empty', '-m', 'feat: auth (#19)')
    git('checkout', '-q', 'main')
    git('merge', '-q', '--no-ff', 'feat/19-auth', '-m', 'Merge pull request #19 from feat/19-auth')
    git('worktree', 'add', '-q', linked, 'feat/19-auth')
    return { principal, linked }
  }

  it('never offers the principal’s branch for deletion, even when it is fully merged', () => {
    // Run from the linked worktree — the normal posture. `main` is the principal's
    // branch and is trivially "merged into itself", so an analyser that classified
    // it would hand the operator a `git branch -d main`. Protected branches are
    // dropped before classification; delete that filter and this goes red.
    const { principal, linked } = principalAndWorktree()
    try {
      const out = execFileSync('bash', [ANALYZE, '--json', '--no-fetch'], {
        cwd: linked,
        env: FIXTURE_ENV,
        encoding: 'utf8',
      })
      const report = JSON.parse(out)
      expect(report.safe_local).not.toContain('main')
      expect(report.local_branches.map((b: { name: string }) => b.name)).not.toContain('main')
      // The principal is still *reported* — cleanup must be able to show it as the
      // worktree to keep; it is classification for deletion that is out of reach.
      expect(report.worktrees.map((w: { path: string }) => w.path)).toContain(principal)
    } finally {
      rmSync(path.dirname(principal), { recursive: true, force: true })
    }
  })
})
