import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Integration, not unit: sourcing lib.sh forks bash, and vitest.setup.ts fails a
// unit test that forks (#502).
const LIB = path.resolve(import.meta.dirname, '..', 'lib.sh')

/**
 * Git reads GIT_DIR / GIT_WORK_TREE from the environment and they beat `cwd`.
 * Under a git hook — lefthook runs this suite on pre-push — they point at
 * whatever repository invoked the hook, so a probe would answer about the wrong
 * one (#532).
 */
function envWithoutGit(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
}

function runHelper(snippet: string, cwd: string): string {
  return execFileSync('bash', ['-c', `source ${JSON.stringify(LIB)} && ${snippet}`], {
    cwd,
    encoding: 'utf8',
    env: envWithoutGit(),
  }).trim()
}

/** A throwaway repo whose remote-tracking refs we control. */
function fixtureRepo(bases: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'omp-build-lib-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env: envWithoutGit(), stdio: 'ignore' })
  git('init', '-q')
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'root')
  for (const base of bases) git('update-ref', `refs/remotes/origin/${base}`, 'HEAD')
  return dir
}

describe('omp-build shared/lib.sh', () => {
  it('sources and resolves from the omp-build path', () => {
    // #491's acceptance: the helper works from its new home, with no dev-core
    // on disk. Deleting lib.sh turns this red.
    expect(runHelper('detect_base_branch', process.cwd())).toMatch(/^(staging|main|master)$/)
  })

  it('prefers staging over main when the remote carries both', () => {
    // The probe, not the fallback: every branch of detect_base_branch echoes
    // one of staging|main|master, so asserting membership in that set passes
    // on a gutted function (PR #533 review).
    const dir = fixtureRepo(['staging', 'main'])
    try {
      expect(runHelper('detect_base_branch', dir)).toBe('staging')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('falls back to main when the remote carries no base ref', () => {
    const dir = fixtureRepo([])
    try {
      expect(runHelper('detect_base_branch', dir)).toBe('main')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('recognises the protected bases and nothing else', () => {
    expect(runHelper('is_base_branch main && echo yes', process.cwd())).toBe('yes')
    expect(runHelper('is_base_branch feat/x || echo no', process.cwd())).toBe('no')
  })
})
