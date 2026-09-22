import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const script = join(import.meta.dirname, '..', 'check-principal-branch.sh')

function gitEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
  for (const k of Object.keys(env)) {
    if (
      k === 'GIT_DIR' ||
      k === 'GIT_WORK_TREE' ||
      k === 'GIT_INDEX_FILE' ||
      k === 'GIT_COMMON_DIR' ||
      k.startsWith('GIT_CONFIG') ||
      k.startsWith('LEFTHOOK')
    ) {
      delete env[k]
    }
  }
  env.LEFTHOOK = '0'
  env.GIT_AUTHOR_NAME = 't'
  env.GIT_AUTHOR_EMAIL = 't@t'
  env.GIT_COMMITTER_NAME = 't'
  env.GIT_COMMITTER_EMAIL = 't@t'
  return env
}

function git(cwd: string, args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv() })
}

function initRepo(dir: string, branch: string) {
  git(dir, ['init', '-b', branch])
  git(dir, ['config', 'user.email', 't@t'])
  git(dir, ['config', 'user.name', 't'])
  writeFileSync(join(dir, 'README'), 'x\n')
  git(dir, ['add', 'README'])
  git(dir, ['commit', '--no-verify', '-m', 'init'])
}

function runCheck(cwd: string, extra?: NodeJS.ProcessEnv): { code: number; stderr: string } {
  try {
    execFileSync('bash', [script], {
      cwd,
      encoding: 'utf8',
      env: gitEnv(extra),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, stderr: '' }
  } catch (e) {
    const err = e as { status?: number; stderr?: string }
    return { code: err.status ?? 1, stderr: String(err.stderr ?? '') }
  }
}

describe('check-principal-branch.sh', () => {
  let tmp: string

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true })
  })

  it('allows principal on main', () => {
    tmp = mkdtempSync(join(tmpdir(), 'pf-main-'))
    initRepo(tmp, 'main')
    expect(runCheck(tmp).code).toBe(0)
  })

  it('allows principal on staging', () => {
    tmp = mkdtempSync(join(tmpdir(), 'pf-stg-'))
    initRepo(tmp, 'staging')
    expect(runCheck(tmp).code).toBe(0)
  })

  it('denies principal on a feature branch', () => {
    tmp = mkdtempSync(join(tmpdir(), 'pf-feat-'))
    initRepo(tmp, 'main')
    git(tmp, ['checkout', '-b', 'feat/x'])
    const r = runCheck(tmp)
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('feat/x')
    expect(r.stderr).not.toContain('DEV_CORE_ALLOW')
  })

  it('allows a non-principal worktree on a feature branch', () => {
    tmp = mkdtempSync(join(tmpdir(), 'pf-wt-'))
    initRepo(tmp, 'main')
    git(tmp, ['branch', 'feat/x'])
    const wt = join(tmp, 'wt-feat')
    mkdirSync(wt)
    git(tmp, ['worktree', 'add', wt, 'feat/x'])
    expect(runCheck(wt).code).toBe(0)
    expect(runCheck(tmp).code).toBe(0)
  })

  it('honors the escape hatch', () => {
    tmp = mkdtempSync(join(tmpdir(), 'pf-hatch-'))
    initRepo(tmp, 'main')
    git(tmp, ['checkout', '-b', 'feat/x'])
    expect(runCheck(tmp, { DEV_CORE_ALLOW_PRINCIPAL_SWITCH: '1' }).code).toBe(0)
  })

  it('allows a non-git directory', () => {
    tmp = mkdtempSync(join(tmpdir(), 'pf-nogit-'))
    expect(runCheck(tmp).code).toBe(0)
  })
})
