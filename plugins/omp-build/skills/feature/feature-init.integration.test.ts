import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { hermeticGh } from './__fixtures__/feature-init/hermetic'

const CLI = path.resolve(import.meta.dirname, 'feature-init.ts')
const REAL_BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
// A stub gh that always fails, an empty GH_CONFIG_DIR, no GH_* / GITHUB_TOKEN.
const GH_ROOT = mkdtempSync(path.join(tmpdir(), 'omp-init-gh-'))
const ENV: NodeJS.ProcessEnv = hermeticGh(GH_ROOT).env
afterAll(() => rmSync(GH_ROOT, { recursive: true, force: true }))

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

function run(dir: string, ...args: string[]) {
  return spawnSync(REAL_BUN, [CLI, '--dir', dir, ...args], { env: ENV, encoding: 'utf8' })
}

describe('feature init preview', () => {
  it('prints a non-authorizing proposal and leaves the worktree byte-identical', () => {
    root = mkdtempSync(path.join(tmpdir(), 'omp-init-preview-'))
    const repo = principal()
    const wt = path.join(root, 'wt')
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'feat/init')
    const stackPath = path.join(wt, '.dev', 'stack.yml')
    const before = readFileSync(stackPath, 'utf8')

    const preview = run(wt)

    expect(preview.status).toBe(0)
    expect(preview.stdout).toContain('digest: ')
    expect(preview.stdout).toContain('digest is not authorization')
    expect(readFileSync(stackPath, 'utf8')).toBe(before)
  })

  it('allows a principal preview without writing', () => {
    root = mkdtempSync(path.join(tmpdir(), 'omp-init-principal-preview-'))
    const repo = principal()
    const before = readFileSync(path.join(repo, '.dev', 'stack.yml'), 'utf8')

    const result = run(repo)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('digest: ')
    expect(readFileSync(path.join(repo, '.dev', 'stack.yml'), 'utf8')).toBe(before)
  })

  it('refuses apply when the principal is reached through a symlink spelling', () => {
    root = mkdtempSync(path.join(tmpdir(), 'omp-init-principal-symlink-'))
    const repo = principal()
    const alias = path.join(root, 'alias')
    symlinkSync(repo, alias)
    const before = readFileSync(path.join(repo, '.dev', 'stack.yml'), 'utf8')

    const preview = run(alias)
    expect(preview.status).toBe(0)
    const digest = preview.stdout.match(/^digest: ([0-9a-f]{64})$/m)?.[1]
    if (!digest) throw new Error(`missing digest\n${preview.stdout}`)
    const apply = run(alias, '--approve', digest, '--operator-approval', 'ship it')

    expect(apply.status).toBe(2)
    expect(apply.stderr).toContain('init=refused principal')
    expect(readFileSync(path.join(repo, '.dev', 'stack.yml'), 'utf8')).toBe(before)
  })

  it('keeps an authored tracker contract byte-identical during preview', () => {
    root = mkdtempSync(path.join(tmpdir(), 'omp-init-keep-'))
    const repo = principal()
    const contract = '# authored contract\nnot the template\n'
    mkdirSync(path.join(repo, 'docs', 'agents'), { recursive: true })
    writeFileSync(path.join(repo, 'docs', 'agents', 'issue-tracker.md'), contract)
    git(repo, 'add', 'docs/agents/issue-tracker.md')
    git(repo, 'commit', '-q', '-m', 'docs: tracker contract')
    const wt = path.join(root, 'wt')
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'feat/init')

    const preview = run(wt)

    expect(preview.status).toBe(0)
    expect(readFileSync(path.join(wt, 'docs', 'agents', 'issue-tracker.md'), 'utf8')).toBe(contract)
  })

  it('does not mutate under --dry-run', () => {
    root = mkdtempSync(path.join(tmpdir(), 'omp-init-dry-'))
    const repo = principal()
    const wt = path.join(root, 'wt')
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'feat/init')
    const before = readFileSync(path.join(wt, '.dev', 'stack.yml'), 'utf8')

    const preview = run(wt, '--dry-run')

    expect(preview.status).toBe(0)
    expect(readFileSync(path.join(wt, '.dev', 'stack.yml'), 'utf8')).toBe(before)
  })
})
