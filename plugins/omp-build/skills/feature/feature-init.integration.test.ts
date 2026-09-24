import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const CLI = path.resolve(import.meta.dirname, 'feature-init.ts')
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

describe('feature init apply', () => {
  it('writes once, then a second run is a no-op', () => {
    root = mkdtempSync(path.join(tmpdir(), 'omp-init-apply-'))
    const repo = path.join(root, 'repo')
    const wt = path.join(root, 'wt')
    mkdirSync(path.join(repo, '.dev'), { recursive: true })
    writeFileSync(path.join(repo, '.dev', 'stack.yml'), 'schema_version: "1.0"\n')
    writeFileSync(path.join(repo, 'README.md'), 'base\n')
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env: ENV, stdio: 'ignore' })
    git('init', '-q', '-b', 'main')
    git('add', '.')
    git('commit', '-q', '-m', 'chore: base')
    git('worktree', 'add', '-q', wt, '-b', 'feat/init')
    const first = execFileSync('bun', [CLI, '--dir', wt], { env: ENV, encoding: 'utf8' })
    expect(first).toContain('init=done')
    const stamped = readFileSync(path.join(wt, '.dev', 'stack.yml'), 'utf8')
    expect(stamped).toContain('worktree:')
    const second = execFileSync('bun', [CLI, '--dir', wt], { env: ENV, encoding: 'utf8' })
    expect(second.trim()).toBe('init=noop')
    expect(readFileSync(path.join(wt, '.dev', 'stack.yml'), 'utf8')).toBe(stamped)
  })

  it('refuses to write on the principal', () => {
    root = mkdtempSync(path.join(tmpdir(), 'omp-init-principal-'))
    const repo = root
    mkdirSync(path.join(repo, '.dev'))
    writeFileSync(path.join(repo, '.dev', 'stack.yml'), 'schema_version: "1.0"\n')
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env: ENV, stdio: 'ignore' })
    expect(() => execFileSync('bun', [CLI, '--dir', repo], { env: ENV, encoding: 'utf8' })).toThrow(/init=refused/)
  })
})
