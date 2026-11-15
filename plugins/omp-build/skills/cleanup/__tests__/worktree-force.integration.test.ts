import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FIXTURE_ENV, git, initRepo } from './fixture'

const CLI = path.resolve(import.meta.dirname, '..', 'worktrees.ts')
let root = ''
let home = ''
let repo = ''

type Row = {
  path: string
  eligible: boolean
  token: string
  removalMode: 'safe' | 'force'
  activity: 'idle' | 'active' | 'unknown'
  requiresUsageConfirmation: boolean
  requiresArtifactConfirmation: boolean
  requiresDiscardConfirmation: boolean
  localEntries: { status: string; path: string; originalPath?: string }[]
  ignoredEntries: { path: string; kind: string }[]
}

function setup(): string {
  root = mkdtempSync(path.join(tmpdir(), 'cleanup-force-'))
  home = path.join(root, 'home')
  repo = path.join(root, 'repo')
  mkdirSync(home)
  initRepo(repo, home)
  writeFileSync(path.join(repo, '.git', 'info', 'exclude'), '.env\nnode_modules/\n')
  const target = path.join(root, 'linked')
  git(repo, home, 'worktree', 'add', '-q', '-b', 'feat/force', target)
  return target
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = ''
})

function file(base: string, name: string, contents: string): string {
  const result = path.join(base, name)
  mkdirSync(path.dirname(result), { recursive: true })
  writeFileSync(result, contents)
  return result
}

function command(args: string[], cwd = root) {
  return spawnSync('bun', [CLI, ...args, '--json'], {
    cwd,
    env: { ...FIXTURE_ENV, HOME: home },
    encoding: 'utf8',
  })
}

function row(target: string, force = true, cwd = root): Row {
  const result = command(['inventory', '--repo', repo, ...(force ? ['--force'] : [])], cwd)
  expect(result.status, result.stderr || result.stdout).toBe(0)
  const report = JSON.parse(result.stdout) as { worktrees: Row[]; errors: unknown[] }
  expect(report.errors).toEqual([])
  const entry = report.worktrees.find((item) => item.path === target)
  expect(entry, `missing worktree ${target}`).toBeDefined()
  return entry as Row
}

function remove(target: string, entry: Row, extra: string[] = [], cwd = root, usage = true) {
  const args = ['remove', '--repo', repo, '--path', target, '--expect', entry.token, '--confirm', target]
  if (usage && entry.requiresUsageConfirmation) args.push('--ack-unknown-usage', target)
  return command([...args, ...extra], cwd)
}

function forceAck(target: string): string[] {
  return ['--force', '--ack-discard-local-data', target]
}

describe('manual force worktree cleanup', () => {
  it.skipIf(process.platform !== 'linux')(
    'keeps all local data in safe mode and requires exact independent force consent',
    () => {
      const target = setup()
      const tracked = file(target, 'README.md', 'unstaged fixture\n')
      const staged = file(target, 'staged.txt', 'staged fixture\n')
      git(target, home, 'add', 'staged.txt')
      const untracked = file(target, 'untracked.txt', 'untracked fixture\n')
      const secret = file(target, '.env', 'protected fixture\n')
      file(target, 'node_modules/pkg/index.js', 'dependency fixture\n')
      const outside = file(root, 'outside/keep', 'outside fixture\n')
      symlinkSync(path.dirname(outside), path.join(target, 'outside-link'))
      const head = git(repo, home, 'rev-parse', 'refs/heads/feat/force').trim()
      git(repo, home, 'tag', 'fixture-retained', head)

      const safe = row(target, false)
      expect(safe.removalMode).toBe('safe')
      expect(safe.eligible).toBe(false)
      expect(remove(target, safe).status).not.toBe(0)
      const forced = row(target)
      expect(forced.removalMode).toBe('force')
      expect(forced.eligible).toBe(true)
      expect(forced.requiresDiscardConfirmation).toBe(true)
      expect(forced.requiresArtifactConfirmation).toBe(false)
      expect(forced.ignoredEntries).toContainEqual({ path: '.env', kind: 'protected' })
      expect(forced.ignoredEntries).toContainEqual({ path: 'node_modules/', kind: 'dependency' })
      expect(remove(target, forced, ['--force']).status).not.toBe(0)
      expect(remove(target, forced, forceAck(`${target}-other`)).status).not.toBe(0)
      if (forced.requiresUsageConfirmation) {
        expect(remove(target, forced, forceAck(target), root, false).status).not.toBe(0)
        expect(
          remove(target, forced, [...forceAck(target), '--ack-unknown-usage', `${target}-other`], root, false).status,
        ).not.toBe(0)
      }
      expect(readFileSync(tracked, 'utf8')).toBe('unstaged fixture\n')
      expect(readFileSync(staged, 'utf8')).toBe('staged fixture\n')
      expect(readFileSync(untracked, 'utf8')).toBe('untracked fixture\n')
      expect(readFileSync(secret, 'utf8')).toBe('protected fixture\n')
      expect(git(target, home, 'show', ':staged.txt')).toBe('staged fixture\n')
      const result = remove(target, forced, forceAck(target))
      expect(result.status, result.stderr || result.stdout).toBe(0)
      expect(existsSync(target)).toBe(false)
      expect(readFileSync(outside, 'utf8')).toBe('outside fixture\n')
      expect(readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('base\n')
      expect(git(repo, home, 'rev-parse', 'refs/heads/feat/force').trim()).toBe(head)
      expect(git(repo, home, 'rev-parse', 'refs/tags/fixture-retained').trim()).toBe(head)
    },
  )

  it.skipIf(process.platform !== 'linux')('removes a clean force worktree without unnecessary discard consent', () => {
    const target = setup()
    const head = git(repo, home, 'rev-parse', 'refs/heads/feat/force').trim()
    git(repo, home, 'tag', 'fixture-clean', head)
    const entry = row(target)
    expect(entry.removalMode).toBe('force')
    expect(entry.eligible).toBe(true)
    expect(entry.requiresDiscardConfirmation).toBe(false)
    expect(remove(target, entry, forceAck(target)).status).not.toBe(0)
    expect(readFileSync(path.join(target, 'README.md'), 'utf8')).toBe('base\n')
    expect(git(repo, home, 'rev-parse', 'refs/heads/feat/force').trim()).toBe(head)
    const result = remove(target, entry, ['--force'])
    expect(result.status, result.stderr || result.stdout).toBe(0)
    expect(existsSync(target)).toBe(false)
    expect(git(repo, home, 'rev-parse', 'refs/heads/feat/force').trim()).toBe(head)
    expect(git(repo, home, 'rev-parse', 'refs/tags/fixture-clean').trim()).toBe(head)
  })

  it.skipIf(process.platform !== 'linux')(
    'invalidates a token when content changes and its original mtime is restored',
    () => {
      const target = setup()
      const data = file(target, 'notes.txt', 'first content\n')
      const timestamp = 1600000000
      utimesSync(data, timestamp, timestamp)
      const before = statSync(data, { bigint: true })
      const entry = row(target)
      expect(entry.eligible).toBe(true)
      writeFileSync(data, 'other content\n')
      utimesSync(data, timestamp, timestamp)
      const after = statSync(data, { bigint: true })
      expect(after.size).toBe(before.size)
      expect(after.mtimeNs).toBe(before.mtimeNs)
      expect(after.ctimeNs).not.toBe(before.ctimeNs)
      expect(row(target).token).not.toBe(entry.token)
      expect(remove(target, entry, forceAck(target)).status).not.toBe(0)
      expect(readFileSync(data, 'utf8')).toBe('other content\n')
    },
  )

  it('preserves retained administrative submodule repositories without visible gitlinks', () => {
    const target = setup()
    const data = file(target, 'notes.txt', 'local fixture\n')
    const admin = git(target, home, 'rev-parse', '--absolute-git-dir').trim()
    const retained = path.join(admin, 'modules', 'retained')
    mkdirSync(path.dirname(retained), { recursive: true })
    git(repo, home, 'clone', '-q', '--bare', repo, retained)
    const head = git(retained, home, 'rev-parse', 'refs/heads/main').trim()
    git(retained, home, 'update-ref', 'refs/heads/retained-only', head)
    const object = git(retained, home, 'cat-file', '-p', head)
    expect(git(target, home, 'ls-files', '--stage')).not.toContain('160000 ')
    expect(existsSync(path.join(target, 'retained', '.git'))).toBe(false)
    const entry = row(target)
    expect(entry.eligible).toBe(false)
    expect(remove(target, entry, forceAck(target)).status).not.toBe(0)
    expect(readFileSync(data, 'utf8')).toBe('local fixture\n')
    expect(git(retained, home, 'rev-parse', 'refs/heads/retained-only').trim()).toBe(head)
    expect(git(retained, home, 'cat-file', '-p', head)).toBe(object)
  })

  it('does not execute the configured fsmonitor when inventorying local changes', () => {
    const target = setup()
    const marker = path.join(root, 'fsmonitor-invoked')
    const hook = file(root, 'fsmonitor-hook', `#!/bin/sh\nprintf invoked > '${marker}'\n`)
    chmodSync(hook, 0o755)
    git(repo, home, 'config', 'core.fsmonitor', hook)
    git(repo, home, 'config', 'core.untrackedCache', 'true')
    const data = file(target, 'README.md', 'modified fixture\n')
    const safe = row(target, false)
    const forced = row(target)
    expect(safe.eligible).toBe(false)
    expect(forced.localEntries).toContainEqual({ status: ' M', path: 'README.md' })
    expect(existsSync(marker)).toBe(false)
    expect(readFileSync(data, 'utf8')).toBe('modified fixture\n')
  })

  it.skipIf(process.platform !== 'linux')('preserves a file whose name is not valid UTF-8', () => {
    const target = setup()
    const invalidPath = Buffer.concat([Buffer.from(`${target}/invalid-`), Buffer.from([0xff])])
    const contents = Buffer.from([0, 1, 2, 255])
    writeFileSync(invalidPath, contents)
    const entry = row(target)
    expect(entry.eligible).toBe(false)
    expect(remove(target, entry, forceAck(target)).status).not.toBe(0)
    expect(readFileSync(invalidPath)).toEqual(contents)
    expect(readFileSync(path.join(target, 'README.md'), 'utf8')).toBe('base\n')
  })

  it.each(['index.lock', 'HEAD.lock'])('preserves local data and linked worktree admin %s', (name) => {
    const target = setup()
    const data = file(target, 'notes.txt', 'local fixture\n')
    const lock = git(target, home, 'rev-parse', '--path-format=absolute', '--git-path', name).trim()
    writeFileSync(lock, 'lock fixture\n')
    const entry = row(target)
    expect(entry.eligible).toBe(false)
    expect(remove(target, entry, forceAck(target)).status).not.toBe(0)
    expect(readFileSync(data, 'utf8')).toBe('local fixture\n')
    expect(readFileSync(lock, 'utf8')).toBe('lock fixture\n')
  })

  it('rejects cross-mode tokens, duplicate force and invalid acknowledgment options without changing data', () => {
    const target = setup()
    const safe = row(target, false)
    const forced = row(target)
    expect(safe.token).not.toBe(forced.token)
    expect(remove(target, safe, ['--force']).status).not.toBe(0)
    expect(remove(target, forced).status).not.toBe(0)
    expect(command(['inventory', '--repo', repo, '--force', '--force']).status).not.toBe(0)
    expect(command(['inventory', '--repo', repo, '--force', '--ack-discard-local-data', target]).status).not.toBe(0)
    expect(remove(target, forced, ['--force', '--force']).status).not.toBe(0)
    expect(remove(target, safe, ['--ack-discard-local-data', target]).status).not.toBe(0)
    expect(readFileSync(path.join(target, 'README.md'), 'utf8')).toBe('base\n')
    expect(git(repo, home, 'rev-parse', 'refs/heads/feat/force').trim()).toBe(
      git(target, home, 'rev-parse', 'HEAD').trim(),
    )
  })

  it('reports exact porcelain statuses and both paths of a staged rename', () => {
    const target = setup()
    git(target, home, 'mv', 'README.md', 'renamed file.md')
    file(target, 'new file.txt', 'untracked\n')
    file(target, '.env', 'secret\n')
    const entry = row(target)
    expect(entry.localEntries).toEqual(
      expect.arrayContaining([
        { status: 'R ', path: 'renamed file.md', originalPath: 'README.md' },
        { status: '??', path: 'new file.txt' },
        { status: '!!', path: '.env' },
      ]),
    )
    expect(entry.ignoredEntries).toContainEqual({ path: '.env', kind: 'protected' })
    expect(readFileSync(path.join(target, 'renamed file.md'), 'utf8')).toBe('base\n')
    expect(git(target, home, 'show', ':renamed file.md')).toBe('base\n')
  })

  it.skipIf(process.platform !== 'linux').each(['tracked', 'untracked', 'index', 'ignored subtree'])(
    'invalidates force inventory after a same-status %s change',
    (kind) => {
      const target = setup()
      const name =
        kind === 'tracked'
          ? 'README.md'
          : kind === 'index'
            ? 'staged.txt'
            : kind === 'ignored subtree'
              ? 'node_modules/pkg/data'
              : 'notes.txt'
      const changed = file(target, name, 'first fixture\n')
      if (kind === 'index') git(target, home, 'add', name)
      const beforeStatus = git(
        target,
        home,
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--ignored=matching',
      )
      const original = row(target)
      expect(original.eligible).toBe(true)
      writeFileSync(changed, 'other fixture\n')
      if (kind === 'index') git(target, home, 'add', name)
      expect(git(target, home, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching')).toBe(
        beforeStatus,
      )
      const updated = row(target)
      expect(updated.token).not.toBe(original.token)
      expect(remove(target, original, forceAck(target)).status).not.toBe(0)
      expect(readFileSync(changed, 'utf8')).toBe('other fixture\n')
      if (kind === 'index') expect(git(target, home, 'show', ':staged.txt')).toBe('other fixture\n')
    },
  )
  it.skipIf(process.platform !== 'linux')(
    'invalidates a token for an index-only change with identical status and worktree content',
    () => {
      const target = setup()
      const staged = file(target, 'staged.txt', 'index one\n')
      git(target, home, 'add', 'staged.txt')
      writeFileSync(staged, 'worktree fixture\n')
      const replacement = file(root, 'replacement', 'index two\n')
      const oid = git(target, home, 'hash-object', '-w', replacement).trim()
      const status = git(target, home, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching')
      const original = row(target)
      expect(original.eligible).toBe(true)
      git(target, home, 'update-index', '--cacheinfo', '100644', oid, 'staged.txt')
      expect(git(target, home, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching')).toBe(
        status,
      )
      expect(row(target).token).not.toBe(original.token)
      expect(remove(target, original, forceAck(target)).status).not.toBe(0)
      expect(readFileSync(staged, 'utf8')).toBe('worktree fixture\n')
      expect(git(target, home, 'show', ':staged.txt')).toBe('index two\n')
    },
  )

  it.skipIf(process.platform !== 'linux')('preserves a special file outside ignored roots alongside WIP', () => {
    const target = setup()
    const data = file(target, 'notes.txt', 'outer WIP\n')
    const fifo = path.join(target, 'pipe')
    const created = spawnSync('mkfifo', [fifo], { cwd: root, env: { ...FIXTURE_ENV, HOME: home }, encoding: 'utf8' })
    expect(created.status, created.stderr).toBe(0)
    const entry = row(target)
    expect(entry.eligible).toBe(false)
    expect(remove(target, entry, forceAck(target)).status).not.toBe(0)
    expect(lstatSync(fifo).isFIFO()).toBe(true)
    expect(readFileSync(data, 'utf8')).toBe('outer WIP\n')
  })

  it('retains principal, current, locked and locally unretained detached worktrees with force', () => {
    const current = setup()
    const locked = path.join(root, 'locked')
    git(repo, home, 'worktree', 'add', '-q', '-b', 'feat/locked', locked)
    git(repo, home, 'worktree', 'lock', locked)
    const detached = path.join(root, 'detached')
    git(repo, home, 'worktree', 'add', '-q', '--detach', detached)
    git(detached, home, 'commit', '-q', '--allow-empty', '-m', 'unretained')
    const detachedHead = git(detached, home, 'rev-parse', 'HEAD').trim()
    git(repo, home, 'update-ref', 'refs/remotes/origin/only', detachedHead)
    for (const target of [repo, current, locked, detached]) {
      const cwd = target === current ? current : root
      const entry = row(target, true, cwd)
      expect(entry.eligible).toBe(false)
      expect(remove(target, entry, forceAck(target), cwd).status).not.toBe(0)
      expect(readFileSync(path.join(target, 'README.md'), 'utf8')).toBe('base\n')
    }
    expect(git(detached, home, 'rev-parse', 'HEAD').trim()).toBe(detachedHead)
    expect(git(repo, home, 'rev-parse', 'refs/remotes/origin/only').trim()).toBe(detachedHead)
  })

  it.each(['--skip-worktree', '--assume-unchanged'])('does not override %s index protection', (flag) => {
    const target = setup()
    git(target, home, 'update-index', flag, 'README.md')
    const data = file(target, 'README.md', 'hidden fixture\n')
    const entry = row(target)
    expect(entry.eligible).toBe(false)
    expect(remove(target, entry, forceAck(target)).status).not.toBe(0)
    expect(readFileSync(data, 'utf8')).toBe('hidden fixture\n')
  })

  it('preserves a worktree with Git merge in progress alongside local data', () => {
    const target = setup()
    const commit = git(target, home, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'other').trim()
    git(target, home, 'merge', '--no-commit', '--no-ff', commit)
    const data = file(target, 'notes.txt', 'local fixture\n')
    const entry = row(target)
    expect(entry.eligible).toBe(false)
    expect(remove(target, entry, forceAck(target)).status).not.toBe(0)
    expect(readFileSync(data, 'utf8')).toBe('local fixture\n')
    expect(git(target, home, 'rev-parse', 'MERGE_HEAD').trim()).toBe(commit)
  })

  it('preserves active process worktrees despite force acknowledgment', async () => {
    const target = setup()
    const data = file(target, 'notes.txt', 'active fixture\n')
    const child = spawn('sleep', ['60'], { cwd: target, stdio: 'ignore' })
    try {
      await once(child, 'spawn')
      const entry = row(target)
      expect(entry.activity).toBe('active')
      expect(entry.eligible).toBe(false)
      expect(remove(target, entry, forceAck(target)).status).not.toBe(0)
      expect(readFileSync(data, 'utf8')).toBe('active fixture\n')
    } finally {
      child.kill()
      await once(child, 'exit')
    }
  })

  it.each(['working', 'bare', 'linked'])(
    'preserves a nested %s repository outside ignored roots alongside WIP',
    (kind) => {
      const target = setup()
      const wip = file(target, 'notes.txt', 'outer WIP\n')
      const nested = path.join(target, 'nested', 'repository')
      mkdirSync(path.dirname(nested), { recursive: true })
      let refRepo = nested
      let ref = 'refs/heads/main'
      if (kind === 'working') initRepo(nested, home)
      else if (kind === 'bare') git(repo, home, 'clone', '-q', '--bare', repo, nested)
      else {
        refRepo = path.join(root, 'external')
        initRepo(refRepo, home)
        git(refRepo, home, 'worktree', 'add', '-q', '-b', 'fixture-linked', nested)
        ref = 'refs/heads/fixture-linked'
        expect(lstatSync(path.join(nested, '.git')).isFile()).toBe(true)
      }
      const head = git(refRepo, home, 'rev-parse', ref).trim()
      const entry = row(target)
      expect(entry.eligible).toBe(false)
      expect(remove(target, entry, forceAck(target)).status).not.toBe(0)
      expect(readFileSync(wip, 'utf8')).toBe('outer WIP\n')
      expect(git(refRepo, home, 'rev-parse', ref).trim()).toBe(head)
      expect(existsSync(nested)).toBe(true)
    },
  )
})
