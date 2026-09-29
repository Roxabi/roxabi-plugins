import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const CLI = path.resolve(import.meta.dirname, 'feature-init.ts')
const TRIAGE = path.resolve(import.meta.dirname, '../../../issue-triage/skills/issue-triage/triage.ts')
const REAL_BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const EXPECTED_NEXT = 'next: T=$(realpath skill://issue-triage/triage.ts) && bun "$T" init'
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
    expect(first.stdout).toContain(EXPECTED_NEXT)
    expect(first.stdout).not.toContain('init=done')
    expect(first.stderr).not.toContain('skill://')
    const stamped = readFileSync(path.join(wt, '.dev', 'stack.yml'), 'utf8')
    expect(stamped).toContain('worktree:')
    const gitDir = execFileSync('git', ['rev-parse', '--git-dir'], { cwd: wt, env: ENV, encoding: 'utf8' }).trim()
    const marker = path.resolve(wt, gitDir, 'omp-build-feature-init')
    expect(existsSync(marker)).toBe(false)
    const second = run(wt)
    expect(second.status).toBe(0)
    expect(second.stdout).toContain(EXPECTED_NEXT)
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
    expect(out.stdout).toContain(EXPECTED_NEXT)
    expect(out.stdout).not.toContain('init=done')
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
    expect(next).toBe(`${EXPECTED_NEXT} --dry-run`)
    expect(readFileSync(path.join(wt, '.dev', 'stack.yml'), 'utf8')).toBe(before)
  })

  it('executes the printed next line through bash with a realpath stub (fails on bare skill:// argv)', () => {
    root = mkdtempSync(path.join(tmpdir(), 'omp-init-next-run-'))
    const repo = principal()
    const wt = path.join(root, 'wt')
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'feat/init')
    const out = spawnSync(REAL_BUN, [CLI, '--dry-run', '--dir', wt], { env: ENV, encoding: 'utf8' })
    expect(out.status).toBe(0)
    const next = out.stdout.split('\n').find((line) => line.startsWith('next:'))
    expect(next).toBe(`${EXPECTED_NEXT} --dry-run`)
    expect(next).not.toMatch(/bun skill:\/\//)
    if (next === undefined) throw new Error('missing next line')

    const bin = path.join(root, 'bin')
    mkdirSync(bin)
    writeFileSync(
      path.join(bin, 'realpath'),
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1-}" = "skill://issue-triage/triage.ts" ]; then
  printf '%s\\n' ${JSON.stringify(TRIAGE)}
  exit 0
fi
exec /usr/bin/realpath "$@"
`,
      { mode: 0o755 },
    )
    writeFileSync(
      path.join(bin, 'gh'),
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *auth*token* ]]; then printf 'stub-token\\n'; exit 0; fi
if [[ "$*" == *label*list* ]]; then printf '[]\\n'; exit 0; fi
if [[ "$*" == *issue*list* ]]; then printf '[]\\n'; exit 0; fi
printf '[]\\n'
`,
      { mode: 0o755 },
    )

    const cmd = next.replace(/^next:\s*/, '')
    const result = spawnSync('bash', ['-lc', cmd], {
      cwd: wt,
      env: {
        ...ENV,
        PATH: `${bin}:${path.dirname(REAL_BUN)}:${process.env.PATH ?? ''}`,
        GITHUB_REPO: 'acme/fixture',
      },
      encoding: 'utf8',
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('dry-run: true')
    expect(result.stderr).not.toContain('Module not found')
  })

  it('exits non-zero when the printed next line targets an unresolvable skill', () => {
    // The inline `bun "$(realpath …)"` form exits 0 on a miss (`bun ""` prints
    // usage). The fail-closed `T=$(realpath …) && bun "$T"` form must not.
    const cmd = EXPECTED_NEXT.replace(/^next:\s*/, '').replace(
      'skill://issue-triage/triage.ts',
      'skill://issue-triagex/triage.ts',
    )
    const result = spawnSync('bash', ['-c', cmd], { env: ENV, encoding: 'utf8' })
    expect(result.status).not.toBe(0)
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/No such file or directory/)
  })
})
