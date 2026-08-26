import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ensureWorktree, GIT_HOOK_VARS, stripGitHookEnv } from './workflow.js'

function gitEnv(extra = {}) {
  return stripGitHookEnv({ ...process.env, ...extra })
}

beforeAll(() => {
  vi.spyOn(Bun, 'spawn').mockImplementation((cmd, opts) => {
    const proc = spawn(cmd[0], cmd.slice(1), {
      cwd: opts?.cwd,
      env: gitEnv(opts?.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return {
      stdout: Readable.toWeb(proc.stdout),
      stderr: Readable.toWeb(proc.stderr),
      exited: new Promise((resolve) => proc.on('close', (code) => resolve(code ?? 1))),
    }
  })

  if (typeof Bun.$ !== 'function') {
    Bun.$ = (strings, ...values) => {
      let cmd = ''
      for (let i = 0; i < strings.length; i++) {
        cmd += strings[i]
        if (i < values.length) cmd += String(values[i])
      }
      return {
        quiet() {
          const r = spawnSync('bash', ['-c', cmd], { env: gitEnv() })
          if (r.status !== 0) throw new Error(`Bun.$ failed (${r.status}): ${cmd}`)
          return Promise.resolve({ exitCode: 0 })
        },
      }
    }
  }
})

function git(cwd, args, extra = {}) {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    env: gitEnv(extra),
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  }
  return (result.stdout || '').trim()
}

function makeNames(tmpHome, repoName = 'repo') {
  return {
    type: 'feat',
    slug: 'test-slug',
    issue: 42,
    branch: 'feat/42-test-slug',
    worktree: join(tmpHome, '.omp/worktrees', repoName, 'feat-42-test-slug'),
  }
}

function createFixture() {
  const tmpHome = mkdtempSync(join(tmpdir(), 'ensure-wt-home-'))
  const base = mkdtempSync(join(tmpdir(), 'ensure-wt-'))
  const originPath = join(base, 'origin.git')
  const repoPath = join(base, 'repo')
  const env = { HOME: tmpHome }

  spawnSync('git', ['init', '--bare', originPath], { env: gitEnv(env), encoding: 'utf8' })
  spawnSync('git', ['init', repoPath], { env: gitEnv(env), encoding: 'utf8' })
  git(repoPath, ['config', 'user.email', 'test@example.com'], env)
  git(repoPath, ['config', 'user.name', 'Test User'], env)
  git(repoPath, ['commit', '--allow-empty', '-m', 'init'], env)
  git(repoPath, ['checkout', '-b', 'staging'], env)
  git(repoPath, ['remote', 'add', 'origin', originPath], env)
  git(repoPath, ['push', '-u', 'origin', 'staging'], env)

  return { tmpHome, base, repoPath, env, names: makeNames(tmpHome) }
}

/** @type {Array<{ base: string, tmpHome: string, worktrees: string[] }>} */
const fixtures = []

afterEach(() => {
  for (const fx of fixtures.splice(0)) {
    for (const wt of fx.worktrees) {
      spawnSync('git', ['worktree', 'remove', '--force', wt], {
        env: gitEnv({ HOME: fx.tmpHome }),
        encoding: 'utf8',
      })
    }
    rmSync(fx.base, { recursive: true, force: true })
    rmSync(fx.tmpHome, { recursive: true, force: true })
  }
})

describe('stripGitHookEnv', () => {
  it('drops every git_probe var and keeps the rest', () => {
    const poisoned = Object.fromEntries(GIT_HOOK_VARS.map((key) => [key, '/decoy']))
    const cleaned = stripGitHookEnv({ PATH: '/bin', ...poisoned })
    for (const key of GIT_HOOK_VARS) expect(cleaned[key]).toBeUndefined()
    expect(cleaned.PATH).toBe('/bin')
  })
})

describe('ensureWorktree', () => {
  it('creates a worktree without switching principal HEAD off staging', async () => {
    const fx = createFixture()
    fixtures.push({ base: fx.base, tmpHome: fx.tmpHome, worktrees: [fx.names.worktree] })

    const shaBefore = git(fx.repoPath, ['rev-parse', 'HEAD'], fx.env)
    const headBefore = git(fx.repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'], fx.env)
    expect(headBefore).toBe('staging')

    const resolved = await ensureWorktree(fx.repoPath, fx.names)

    const headAfter = git(fx.repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'], fx.env)
    const shaAfter = git(fx.repoPath, ['rev-parse', 'HEAD'], fx.env)
    expect(headAfter).toBe('staging')
    expect(shaAfter).toBe(shaBefore)
    expect(resolved.worktree).toBe(fx.names.worktree)

    const wtHead = git(fx.names.worktree, ['rev-parse', '--abbrev-ref', 'HEAD'], fx.env)
    expect(wtHead).toBe('feat/42-test-slug')
  })

  it('does not follow a poisoned GIT_DIR', () => {
    const decoy = mkdtempSync(join(tmpdir(), 'git-dir-decoy-'))
    spawnSync('git', ['init', decoy], { env: gitEnv(), encoding: 'utf8' })
    const prev = process.env.GIT_DIR
    process.env.GIT_DIR = join(decoy, '.git')
    try {
      const fx = createFixture()
      fixtures.push({ base: fx.base, tmpHome: fx.tmpHome, worktrees: [] })
      const gitDir = git(fx.repoPath, ['rev-parse', '--absolute-git-dir'], fx.env)
      expect(gitDir.startsWith(fx.repoPath)).toBe(true)
      expect(gitDir.includes(decoy)).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = prev
      rmSync(decoy, { recursive: true, force: true })
    }
  })

  it('refuses a dirty principal and leaves HEAD on staging', async () => {
    const fx = createFixture()
    fixtures.push({ base: fx.base, tmpHome: fx.tmpHome, worktrees: [] })

    spawnSync('bash', ['-c', 'echo dirty > dirty.txt'], { cwd: fx.repoPath, env: fx.env })

    await expect(ensureWorktree(fx.repoPath, fx.names)).rejects.toThrow(/dirty/)

    const head = git(fx.repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'], fx.env)
    expect(head).toBe('staging')
  })

  it('refuses when principal HEAD is a feature branch', async () => {
    const fx = createFixture()
    fixtures.push({ base: fx.base, tmpHome: fx.tmpHome, worktrees: [] })

    git(fx.repoPath, ['checkout', '-b', 'feat/x'], fx.env)

    await expect(ensureWorktree(fx.repoPath, fx.names)).rejects.toThrow(/refuse/)

    const head = git(fx.repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'], fx.env)
    expect(head).toBe('feat/x')
  })

  it('is a no-op when the worktree is already listed', async () => {
    const fx = createFixture()
    fixtures.push({ base: fx.base, tmpHome: fx.tmpHome, worktrees: [fx.names.worktree] })

    const first = await ensureWorktree(fx.repoPath, fx.names)
    const shaBefore = git(fx.repoPath, ['rev-parse', 'HEAD'], fx.env)

    const second = await ensureWorktree(fx.repoPath, fx.names)

    const head = git(fx.repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'], fx.env)
    const shaAfter = git(fx.repoPath, ['rev-parse', 'HEAD'], fx.env)
    expect(head).toBe('staging')
    expect(shaAfter).toBe(shaBefore)
    expect(second.worktree).toBe(first.worktree)
  })
})
