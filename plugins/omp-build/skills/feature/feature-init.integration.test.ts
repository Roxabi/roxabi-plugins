import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

function fakeBun(): { log: string; env: NodeJS.ProcessEnv } {
  if (!root) throw new Error('fixture missing')
  const bin = path.join(root, 'bin')
  const log = path.join(root, 'bun.log')
  mkdirSync(bin)
  writeFileSync(
    path.join(bin, 'bun'),
    `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
if [ "$1" = "skill://issue-triage/triage.ts" ]; then
  echo "contract: keep-existing"
  exit 0
fi
exec ${JSON.stringify(REAL_BUN)} "$@"
`,
  )
  chmodSync(path.join(bin, 'bun'), 0o755)
  return { log, env: { ...ENV, PATH: `${bin}:${process.env.PATH ?? ''}` } }
}

describe('feature init apply', () => {
  it('writes once, then a second run is a no-op', () => {
    root = mkdtempSync(path.join(tmpdir(), 'omp-init-apply-'))
    const repo = principal()
    const wt = path.join(root, 'wt')
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'feat/init')
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
    git(repo, 'init', '-q', '-b', 'main')
    expect(() => execFileSync('bun', [CLI, '--dir', repo], { env: ENV, encoding: 'utf8' })).toThrow(/init=refused/)
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
    const { log, env } = fakeBun()
    const out = execFileSync(REAL_BUN, [CLI, '--dir', wt], { env, encoding: 'utf8' })
    expect(out).toContain('init=done')
    expect(out).not.toContain('contract:')
    expect(existsSync(log) ? readFileSync(log, 'utf8') : '').not.toContain('skill://issue-triage/triage.ts')
    expect(readFileSync(path.join(wt, 'docs', 'agents', 'issue-tracker.md'), 'utf8')).toBe(contract)
    expect(
      execFileSync('git', ['status', '--porcelain', '--', 'docs/agents'], { cwd: wt, env, encoding: 'utf8' }),
    ).toBe('')
  })

  it('surfaces issue-triage init output when the contract is absent', () => {
    root = mkdtempSync(path.join(tmpdir(), 'omp-init-surface-'))
    const repo = principal()
    const wt = path.join(root, 'wt')
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'feat/init')
    const { log, env } = fakeBun()
    const out = execFileSync(REAL_BUN, [CLI, '--dir', wt], { env, encoding: 'utf8' })
    expect(out).toContain('contract: keep-existing')
    expect(out).toContain('init=done')
    expect(readFileSync(log, 'utf8')).toContain('skill://issue-triage/triage.ts init')
  })
})
