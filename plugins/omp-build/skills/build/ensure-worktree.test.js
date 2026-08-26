import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ensureWorktree } from './workflow.js'

beforeAll(() => {
  vi.spyOn(Bun, 'spawn').mockImplementation((cmd, opts) => {
    const proc = spawn(cmd[0], cmd.slice(1), {
      cwd: opts?.cwd,
      env: opts?.env ? { ...process.env, ...opts.env } : process.env,
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
          const r = spawnSync('bash', ['-c', cmd])
          if (r.status !== 0) throw new Error(`Bun.$ failed (${r.status}): ${cmd}`)
          return Promise.resolve({ exitCode: 0 })
        },
      }
    }
  }
})

function git(cwd, args, env = {}) {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    env: { ...process.env, ...env },
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

  spawnSync('git', ['init', '--bare', originPath], { env, encoding: 'utf8' })
  spawnSync('git', ['init', repoPath], { env, encoding: 'utf8' })
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
        env: { ...process.env, HOME: fx.tmpHome },
        encoding: 'utf8',
      })
    }
    rmSync(fx.base, { recursive: true, force: true })
    rmSync(fx.tmpHome, { recursive: true, force: true })
  }
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
