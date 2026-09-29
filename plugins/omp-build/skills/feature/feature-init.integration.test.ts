import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const CLI = path.resolve(import.meta.dirname, 'feature-init.ts')
const REAL_BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
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

function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, { cwd, env: ENV, stdio: 'ignore' })
}

function principal(): string {
  if (!root) throw new Error('fixture missing')
  const repo = path.join(root, 'repo')
  mkdirSync(path.join(repo, '.dev'), { recursive: true })
  writeFileSync(path.join(repo, '.dev', 'stack.yml'), 'schema_version: "1.0"\n')
  writeFileSync(path.join(repo, 'README.md'), 'base\n')
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'chore: base')
  return repo
}

function run(dir: string) {
  return spawnSync(REAL_BUN, [CLI, '--dir', dir], { env: ENV, encoding: 'utf8' })
}

describe('feature init apply', () => {
  it('writes the stack once and leaves a second run idempotent without claiming the tracker step', () => {
    root = mkdtempSync(path.join(tmpdir(), 'omp-init-apply-'))
    const repo = principal()
    const wt = path.join(root, 'wt')
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'feat/init')
    const first = run(wt)
    expect(first.status).toBe(0)
    expect(first.stdout).toContain('next: bun skill://issue-triage/triage.ts init')
    expect(first.stdout).not.toContain('init=done')
    expect(first.stderr).not.toContain('Module not found')
    expect(first.stderr).not.toContain('skill://')
    const stamped = readFileSync(path.join(wt, '.dev', 'stack.yml'), 'utf8')
    expect(stamped).toContain('worktree:')
    const gitDir = execFileSync('git', ['rev-parse', '--git-dir'], { cwd: wt, env: ENV, encoding: 'utf8' }).trim()
    const marker = path.resolve(wt, gitDir, 'omp-build-feature-init')
    expect(existsSync(marker)).toBe(false)
    const second = run(wt)
    expect(second.status).toBe(0)
    expect(second.stdout).toContain('next: bun skill://issue-triage/triage.ts init')
    expect(second.stdout).not.toContain('init=done')
    expect(readFileSync(path.join(wt, '.dev', 'stack.yml'), 'utf8')).toBe(stamped)
  })

  it('refuses to write on the principal', () => {
    root = mkdtempSync(path.join(tmpdir(), 'omp-init-principal-'))
    const repo = root
    mkdirSync(path.join(repo, '.dev'))
    writeFileSync(path.join(repo, '.dev', 'stack.yml'), 'schema_version: "1.0"\n')
    git(repo, 'init', '-q', '-b', 'main')
    const result = run(repo)
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('init=refused')
  })

  it('does not invoke init and leaves an existing contract byte-identical', () => {
    root = mkdtempSync(path.join(tmpdir(), 'omp-init-keep-'))
    const repo = principal()
    const contract = '# authored contract\nnot the template\n'
    mkdirSync(path.join(repo, 'docs', 'agents'), { recursive: true })
    writeFileSync(path.join(repo, 'docs', 'agents', 'issue-tracker.md'), contract)
    git(repo, 'add', 'docs/agents/issue-tracker.md')
    git(repo, 'commit', '-q', '-m', 'docs: tracker contract')
    const wt = path.join(root, 'wt')
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'feat/init')
    const out = run(wt)
    expect(out.status).toBe(0)
    expect(out.stdout).toContain('next: bun skill://issue-triage/triage.ts init')
    expect(out.stdout).not.toContain('init=done')
    expect(out.stderr).not.toContain('Module not found')
    expect(readFileSync(path.join(wt, 'docs', 'agents', 'issue-tracker.md'), 'utf8')).toBe(contract)
    expect(
      execFileSync('git', ['status', '--porcelain', '--', 'docs/agents'], { cwd: wt, env: ENV, encoding: 'utf8' }),
    ).toBe('')
  })

  it('dry-run prints the tracker command with --dry-run and writes nothing', () => {
    root = mkdtempSync(path.join(tmpdir(), 'omp-init-dry-'))
    const repo = principal()
    const wt = path.join(root, 'wt')
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'feat/init')
    const before = readFileSync(path.join(wt, '.dev', 'stack.yml'), 'utf8')
    const out = spawnSync(REAL_BUN, [CLI, '--dry-run', '--dir', wt], { env: ENV, encoding: 'utf8' })
    const next = out.stdout.split('\n').find((line) => line.startsWith('next:'))
    expect(out.status).toBe(0)
    expect(next).toContain('--dry-run')
    expect(next).toBe('next: bun skill://issue-triage/triage.ts init --dry-run')
    expect(readFileSync(path.join(wt, '.dev', 'stack.yml'), 'utf8')).toBe(before)
  })
})
