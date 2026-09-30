import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { detectPrincipal } from './workflow.js'

function gitEnv(extra = {}) {
  const env = { ...process.env, ...extra }
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key]
  }
  return env
}

beforeAll(() => {
  vi.spyOn(Bun, 'spawn').mockImplementation((cmd, opts) => {
    const proc = spawn(cmd[0], cmd.slice(1), {
      cwd: opts?.cwd,
      env: opts?.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return {
      stdout: Readable.toWeb(proc.stdout),
      stderr: Readable.toWeb(proc.stderr),
      exited: new Promise((resolve) => proc.on('close', (code) => resolve(code ?? 1))),
    }
  })
})

function git(cwd, args, env = gitEnv()) {
  const result = spawnSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  }
  return (result.stdout || '').trim()
}

describe('detectPrincipal', () => {
  const dirs = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('uses the named repo when GIT_DIR points at a decoy', async () => {
    const base = mkdtempSync(join(tmpdir(), 'detect-principal-'))
    dirs.push(base)
    const origin = join(base, 'origin.git')
    const repo = join(base, 'repo')
    const decoy = join(base, 'decoy')
    const env = gitEnv()

    spawnSync('git', ['init', '--bare', '-b', 'main', origin], { env, encoding: 'utf8' })
    spawnSync('git', ['init', '-b', 'main', repo], { env, encoding: 'utf8' })
    git(repo, ['config', 'user.email', 'test@example.com'], env)
    git(repo, ['config', 'user.name', 'Test'], env)
    git(repo, ['commit', '--allow-empty', '-m', 'init'], env)
    git(repo, ['remote', 'add', 'origin', origin], env)
    git(repo, ['push', '-u', 'origin', 'main'], env)

    spawnSync('git', ['init', '-b', 'staging', decoy], { env, encoding: 'utf8' })
    git(decoy, ['config', 'user.email', 'test@example.com'], env)
    git(decoy, ['config', 'user.name', 'Test'], env)
    git(decoy, ['commit', '--allow-empty', '-m', 'seed'], env)
    const decoyBefore = git(decoy, ['status', '--porcelain'], env)
    const decoyHead = git(decoy, ['rev-parse', 'HEAD'], env)
    const decoyBranches = git(decoy, ['branch', '--list'], env)

    const prev = process.env.GIT_DIR
    process.env.GIT_DIR = join(decoy, '.git')
    try {
      await expect(detectPrincipal(repo)).resolves.toBe('main')
    } finally {
      if (prev === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = prev
    }

    expect(git(decoy, ['status', '--porcelain'], env)).toBe(decoyBefore)
    expect(git(decoy, ['rev-parse', 'HEAD'], env)).toBe(decoyHead)
    expect(git(decoy, ['branch', '--list'], env)).toBe(decoyBranches)
    expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'], env)).toBe('main')
  })
})
