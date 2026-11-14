import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FIXTURE_ENV, git, initRepo } from './fixture'

const CLI = path.resolve(import.meta.dirname, '..', 'worktrees.ts')
let root: string
let home: string
let repo: string

type Row = {
  path: string
  branch: string | null
  eligible: boolean
  token: string
  activity: 'idle' | 'active' | 'unknown'
  requiresUsageConfirmation: boolean
  localChanges: { tracked: number; untracked: number; ignored: number } | null
}
type Report = {
  version: number
  repositories: { path: string; commonDir: string }[]
  worktrees: Row[]
  errors: { path: string; message: string }[]
}

function setup(): void {
  root = mkdtempSync(path.join(tmpdir(), 'cleanup-cli-'))
  home = path.join(root, 'home')
  repo = path.join(root, 'repo')
  mkdirSync(home)
  initRepo(repo, home)
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

function command(args: string[], cwd = root) {
  return spawnSync('bun', [CLI, ...args, '--json'], {
    cwd,
    env: { ...FIXTURE_ENV, HOME: home },
    encoding: 'utf8',
  })
}

function inventory(args = ['--repo', repo], cwd = root): Report {
  const result = command(['inventory', ...args], cwd)
  expect(result.status, result.stderr).toBe(0)
  const report = JSON.parse(result.stdout) as Report
  expect(report.version).toBe(1)
  expect(report.errors).toEqual([])
  return report
}

function row(target: string): Row {
  const found = inventory().worktrees.find((item) => item.path === target)
  expect(found, `missing worktree ${target}`).toBeDefined()
  return found as Row
}

function remove(target: string, entry: Row, confirm = target, cwd = root) {
  const args = ['remove', '--repo', repo, '--path', target, '--expect', entry.token, '--confirm', confirm]
  if (entry.activity === 'unknown') args.push('--ack-unknown-usage', target)
  return command(args, cwd)
}

function linked(name: string, branch = `feat/${name}`): string {
  const target = path.join(root, name)
  git(repo, home, 'worktree', 'add', '-q', '-b', branch, target)
  return target
}

describe('worktree cleanup CLI', () => {
  it('discovers independent nested repositories, deduplicates common directories, and scopes issue numbers exactly', () => {
    setup()
    const nested = path.join(repo, 'nested')
    const other = path.join(root, 'archive', 'other')
    initRepo(nested, home)
    initRepo(other, home)
    const match = linked('nineteen', 'feat/19-change')
    const nonmatch = linked('three-nineteen', 'feat/319-change')
    const report = inventory(['--root', root, '--root', repo])
    expect(new Set(report.repositories.map((item) => item.commonDir)).size).toBe(3)
    expect(report.repositories.map((item) => item.path)).toEqual(expect.arrayContaining([repo, nested, other]))
    const scoped = inventory(['--repo', repo, '--scope', '19'])
    expect(scoped.worktrees.map((item) => item.path)).toContain(match)
    expect(scoped.worktrees.map((item) => item.path)).not.toContain(nonmatch)
  })

  it('removes a clean registered worktree but preserves its branch', () => {
    setup()
    const target = linked('clean')
    const entry = row(target)
    expect(entry.eligible).toBe(true)
    if (entry.activity === 'unknown') {
      expect(entry.requiresUsageConfirmation).toBe(true)
      const args = ['remove', '--repo', repo, '--path', target, '--expect', entry.token, '--confirm', target]
      expect(command(args).status).not.toBe(0)
      expect(command([...args, '--ack-unknown-usage', `${target}-other`]).status).not.toBe(0)
      expect(existsSync(target)).toBe(true)
    }
    const result = remove(target, entry)
    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(target)).toBe(false)
    expect(git(repo, home, 'rev-parse', '--verify', 'refs/heads/feat/clean').trim()).toMatch(/^[0-9a-f]+$/)
  })

  it.each(['tracked', 'untracked', 'ignored'])('refuses %s data without changing its contents', (kind) => {
    setup()
    const target = linked(`dirty-${kind}`)
    if (kind === 'ignored') {
      writeFileSync(path.join(repo, '.git', 'info', 'exclude'), '.env\n')
    }
    const file = path.join(target, kind === 'tracked' ? 'README.md' : kind === 'ignored' ? '.env' : 'notes.txt')
    writeFileSync(file, `precious ${kind}\n`)
    const entry = row(target)
    expect(entry.localChanges?.[kind as 'tracked' | 'untracked' | 'ignored']).toBeGreaterThan(0)
    expect(entry.eligible).toBe(false)
    expect(remove(target, entry).status).not.toBe(0)
    expect(readFileSync(file, 'utf8')).toBe(`precious ${kind}\n`)
  })

  it.each(['--skip-worktree', '--assume-unchanged'])('preserves modified files hidden by %s', (flag) => {
    setup()
    const target = linked(`hidden-${flag.slice(2)}`)
    git(target, home, 'update-index', flag, 'README.md')
    const file = path.join(target, 'README.md')
    writeFileSync(file, 'hidden local data\n')
    expect(git(target, home, 'status', '--porcelain').trim()).toBe('')
    const entry = row(target)
    expect(entry.eligible).toBe(false)
    expect(remove(target, entry).status).not.toBe(0)
    expect(readFileSync(file, 'utf8')).toBe('hidden local data\n')
  })

  it('preserves a clean worktree with a merge in progress', () => {
    setup()
    const target = linked('merging')
    const commit = git(target, home, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'other').trim()
    git(target, home, 'merge', '--no-commit', '--no-ff', commit)
    expect(git(target, home, 'status', '--porcelain').trim()).toBe('')
    const entry = row(target)
    expect(entry.eligible).toBe(false)
    expect(remove(target, entry).status).not.toBe(0)
    expect(git(target, home, 'rev-parse', '--verify', 'MERGE_HEAD').trim()).toBe(commit)
  })

  it('removes a clean worktree even when another registered worktree is prunable', () => {
    setup()
    const target = linked('healthy')
    const missing = linked('missing')
    rmSync(missing, { recursive: true })
    const result = command(['inventory', '--repo', repo])
    expect(result.status).not.toBe(0)
    const report = JSON.parse(result.stdout) as Report
    expect(report.errors.some((error) => error.path === missing && error.message.length > 0)).toBe(true)
    const entry = report.worktrees.find((item) => item.path === target)
    expect(entry, `missing ${target}`).toBeDefined()
    if (!entry) throw new Error(`missing ${target}`)
    expect(entry.eligible).toBe(true)
    expect(remove(target, entry).status).toBe(0)
    expect(existsSync(target)).toBe(false)
    expect(git(repo, home, 'rev-parse', '--verify', 'refs/heads/feat/healthy').trim()).toMatch(/^[0-9a-f]+$/)
  })

  it('removes a clean linked worktree of a bare repository without deleting its branch', () => {
    setup()
    const bare = path.join(root, 'bare.git')
    git(repo, home, 'clone', '-q', '--bare', repo, bare)
    repo = bare
    const target = linked('bare-linked')
    const entry = row(target)
    expect(entry.eligible).toBe(true)
    const result = remove(target, entry)
    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(target)).toBe(false)
    expect(git(repo, home, 'rev-parse', '--verify', 'refs/heads/feat/bare-linked').trim()).toMatch(/^[0-9a-f]+$/)
  })

  it('protects principal, current, locked and detached remote-only worktrees', () => {
    setup()
    const current = linked('current')
    const locked = linked('locked')
    git(repo, home, 'worktree', 'lock', locked)
    const detached = path.join(root, 'detached')
    git(repo, home, 'worktree', 'add', '-q', '--detach', detached)
    git(detached, home, 'commit', '-q', '--allow-empty', '-m', 'unreferenced')
    const detachedHead = git(detached, home, 'rev-parse', 'HEAD').trim()
    git(repo, home, 'update-ref', 'refs/remotes/origin/detached-only', detachedHead)
    const report = inventory(['--repo', repo], current)
    for (const target of [repo, current, locked, detached]) {
      const entry = report.worktrees.find((item) => item.path === target)
      expect(entry, `missing ${target}`).toBeDefined()
      if (!entry) throw new Error(`missing ${target}`)
      expect(entry.eligible).toBe(false)
      expect(remove(target, entry, target, target === current ? current : root).status).not.toBe(0)
      expect(existsSync(target)).toBe(true)
    }
  })

  it('rejects wrong confirmation, wrong token, changed HEAD and path replacement', () => {
    setup()
    const target = linked('stale')
    const original = row(target)
    expect(original.eligible).toBe(true)
    expect(remove(target, original, `${target}-other`).status).not.toBe(0)
    expect(remove(target, { ...original, token: 'incorrect-token' }).status).not.toBe(0)
    git(target, home, 'commit', '-q', '--allow-empty', '-m', 'changed')
    expect(remove(target, original).status).not.toBe(0)
    const updated = row(target)
    const originalInode = statSync(target).ino
    git(repo, home, 'worktree', 'remove', target)
    mkdirSync(path.join(root, 'inode-guard'))
    git(repo, home, 'worktree', 'add', '-q', target, 'feat/stale')
    expect(statSync(target).ino).not.toBe(originalInode)
    expect(git(target, home, 'rev-parse', 'HEAD').trim()).toBe(git(repo, home, 'rev-parse', 'feat/stale').trim())
    expect(remove(target, updated).status).not.toBe(0)
    expect(existsSync(path.join(target, 'README.md'))).toBe(true)
  })

  it('removes only empty orphans and refuses an orphan that gains content after inventory', () => {
    setup()
    const base = path.join(home, '.omp', 'worktrees', 'repo')
    const empty = path.join(base, 'empty')
    const changed = path.join(base, 'changed')
    const nonempty = path.join(base, 'nonempty')
    for (const dir of [empty, changed, nonempty]) mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(nonempty, 'keep'), 'original')
    const report = inventory()
    const find = (target: string) => {
      const entry = report.worktrees.find((item) => item.path === target)
      expect(entry, `missing orphan ${target}`).toBeDefined()
      return entry as Row
    }
    const emptyRow = find(empty)
    const changedRow = find(changed)
    const nonemptyRow = find(nonempty)
    expect(emptyRow.eligible).toBe(true)
    expect(changedRow.eligible).toBe(true)
    expect(nonemptyRow.eligible).toBe(false)
    writeFileSync(path.join(changed, 'keep'), 'new')
    expect(remove(changed, changedRow).status).not.toBe(0)
    expect(remove(nonempty, nonemptyRow).status).not.toBe(0)
    expect(remove(empty, emptyRow).status).toBe(0)
    expect(existsSync(empty)).toBe(false)
    expect(readFileSync(path.join(changed, 'keep'), 'utf8')).toBe('new')
    expect(readFileSync(path.join(nonempty, 'keep'), 'utf8')).toBe('original')
  })

  it('preserves a worktree used as another process cwd', async () => {
    setup()
    const target = linked('active')
    const child = spawn('sleep', ['60'], { cwd: target, stdio: 'ignore' })
    try {
      await once(child, 'spawn')
      const entry = row(target)
      expect(entry.activity).toBe('active')
      expect(entry.eligible).toBe(false)
      expect(remove(target, entry).status).not.toBe(0)
      expect(existsSync(target)).toBe(true)
    } finally {
      child.kill()
      await once(child, 'exit')
    }
  })

  it('reports Git failures as errors with a nonzero exit', () => {
    setup()
    const notRepo = path.join(root, 'not-a-repo')
    mkdirSync(notRepo)
    const result = command(['inventory', '--repo', repo, '--repo', notRepo])
    expect(result.status).not.toBe(0)
    const report = JSON.parse(result.stdout) as Report
    expect(report.repositories.map((item) => item.path)).toContain(repo)
    expect(report.errors.some((error) => error.path === notRepo && error.message.length > 0)).toBe(true)
  })
})
