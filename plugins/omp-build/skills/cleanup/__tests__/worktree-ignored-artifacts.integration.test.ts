import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
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
  eligible: boolean
  token: string
  activity: 'idle' | 'active' | 'unknown'
  requiresUsageConfirmation: boolean
  requiresArtifactConfirmation: boolean
  ignoredEntries: { path: string; kind: 'dependency' | 'cache' | 'build-output' | 'protected' }[]
  localChanges: { tracked: number; untracked: number; ignored: number } | null
}

function setup(excludes = ''): string {
  root = mkdtempSync(path.join(tmpdir(), 'cleanup-artifacts-'))
  home = path.join(root, 'home')
  repo = path.join(root, 'repo')
  mkdirSync(home)
  initRepo(repo, home)
  writeFileSync(path.join(repo, '.git', 'info', 'exclude'), excludes)
  const target = path.join(root, 'linked')
  git(repo, home, 'worktree', 'add', '-q', '-b', 'feat/artifacts', target)
  return target
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

function file(target: string, name: string, contents = 'fixture data\n'): string {
  const full = path.join(target, name)
  mkdirSync(path.dirname(full), { recursive: true })
  writeFileSync(full, contents)
  return full
}

function command(args: string[]) {
  return spawnSync('bun', [CLI, ...args, '--json'], {
    cwd: root,
    env: { ...FIXTURE_ENV, HOME: home },
    encoding: 'utf8',
  })
}

function row(target: string): Row {
  const result = command(['inventory', '--repo', repo])
  expect(result.status, result.stderr).toBe(0)
  const report = JSON.parse(result.stdout) as { worktrees: Row[]; errors: unknown[] }
  expect(report.errors).toEqual([])
  const entry = report.worktrees.find((item) => item.path === target)
  expect(entry, `missing worktree ${target}`).toBeDefined()
  return entry as Row
}

function remove(target: string, entry: Row, extra: string[] = [], usage = true) {
  const args = ['remove', '--repo', repo, '--path', target, '--expect', entry.token, '--confirm', target]
  if (usage && entry.requiresUsageConfirmation) args.push('--ack-unknown-usage', target)
  return command([...args, ...extra])
}

function ack(target: string): string[] {
  return ['--ack-ignored-artifacts', target]
}

describe('ignored artifact cleanup CLI', () => {
  it.skipIf(process.platform !== 'linux')(
    'requires exact artifact acknowledgment before deleting recognized roots and retaining the branch and outside files',
    () => {
      const target = setup(
        'node_modules/\n.venv/\n__pycache__/\n.cache/trufflehog/\ndist/\n.astro/\ntest-results/\n*.tsbuildinfo\n',
      )
      for (const name of [
        'node_modules/pkg/index.js',
        '.venv/lib/package',
        '__pycache__/module.pyc',
        '.cache/trufflehog/data',
        'dist/index.html',
        '.astro/data',
        'test-results/result.txt',
        'app.tsbuildinfo',
      ])
        file(target, name)
      const outside = file(root, 'outside/keep', 'outside data\n')
      const entry = row(target)
      expect(entry.eligible).toBe(true)
      expect(entry.requiresArtifactConfirmation).toBe(true)
      expect(entry.localChanges?.ignored).toBeGreaterThan(0)
      for (const [name, kind] of [
        ['node_modules', 'dependency'],
        ['.venv', 'dependency'],
        ['__pycache__', 'cache'],
        ['.cache/trufflehog', 'cache'],
        ['dist', 'build-output'],
        ['.astro', 'build-output'],
        ['test-results', 'build-output'],
        ['app.tsbuildinfo', 'cache'],
      ]) {
        expect(
          entry.ignoredEntries.find((item) => item.path.replace(/\/$/, '') === name),
          name,
        ).toMatchObject({ kind })
      }
      expect(remove(target, entry).status).not.toBe(0)
      expect(remove(target, entry, ack(`${target}-other`)).status).not.toBe(0)
      expect(existsSync(path.join(target, 'dist/index.html'))).toBe(true)
      const result = remove(target, entry, ack(target))
      expect(result.status, result.stderr || result.stdout).toBe(0)
      expect(existsSync(target)).toBe(false)
      expect(readFileSync(outside, 'utf8')).toBe('outside data\n')
      expect(git(repo, home, 'rev-parse', '--verify', 'refs/heads/feat/artifacts').trim()).toMatch(/^[0-9a-f]+$/)
      expect(readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('base\n')
    },
  )

  it.skipIf(process.platform === 'linux')('protects recognized artifacts when mount inspection is unsupported', () => {
    const target = setup('node_modules/\n')
    const retained = file(target, 'node_modules/pkg/index.js')
    const entry = row(target)
    expect(entry.eligible).toBe(false)
    expect(remove(target, entry, ack(target)).status).not.toBe(0)
    expect(existsSync(retained)).toBe(true)
  })

  it.each([
    '.env',
    'database.sqlite',
    'reports/export.csv',
    '.cache/other/data',
    'node_modules-backup/data',
    'dist-old/output',
  ])('protects unknown ignored content %s despite acknowledgment', (name) => {
    const target = setup(`${name.split('/')[0]}\n`)
    const protectedFile = file(target, name, 'retain this\n')
    const entry = row(target)
    expect(entry.eligible).toBe(false)
    expect(entry.ignoredEntries.some((item) => item.kind === 'protected')).toBe(true)
    expect(remove(target, entry, ack(target)).status).not.toBe(0)
    expect(readFileSync(protectedFile, 'utf8')).toBe('retain this\n')
  })

  it.each(['node_modules', 'dist'])('does not classify an ignored file named %s as a directory', (name) => {
    const target = setup(`${name}\n`)
    const protectedFile = file(target, name)
    const entry = row(target)
    expect(entry.eligible).toBe(false)
    expect(entry.ignoredEntries.some((item) => item.kind === 'protected')).toBe(true)
    expect(remove(target, entry, ack(target)).status).not.toBe(0)
    expect(existsSync(protectedFile)).toBe(true)
  })

  it('protects an ignored symlink named like a dependency directory', () => {
    const target = setup('node_modules\n')
    const outside = file(root, 'outside/keep', 'outside data\n')
    symlinkSync(path.dirname(outside), path.join(target, 'node_modules'))
    const entry = row(target)
    expect(entry.eligible).toBe(false)
    expect(entry.ignoredEntries.some((item) => item.kind === 'protected')).toBe(true)
    expect(remove(target, entry, ack(target)).status).not.toBe(0)
    expect(readFileSync(outside, 'utf8')).toBe('outside data\n')
  })

  it('protects an ignored symlink named like a tsbuildinfo cache file', () => {
    const target = setup('*.tsbuildinfo\n')
    const outside = file(root, 'outside/keep', 'outside data\n')
    symlinkSync(outside, path.join(target, 'app.tsbuildinfo'))
    const entry = row(target)
    expect(entry.eligible).toBe(false)
    expect(remove(target, entry, ack(target)).status).not.toBe(0)
    expect(existsSync(path.join(target, 'app.tsbuildinfo'))).toBe(true)
    expect(readFileSync(outside, 'utf8')).toBe('outside data\n')
  })

  it('protects an exposed sensitive file under a recognized ancestor', () => {
    const target = setup('.pytest_cache/.env\n')
    const secret = file(target, '.pytest_cache/.env', 'fixture secret\n')
    const entry = row(target)
    expect(entry.eligible).toBe(false)
    expect(entry.ignoredEntries.some((item) => item.kind === 'protected')).toBe(true)
    expect(remove(target, entry, ack(target)).status).not.toBe(0)
    expect(readFileSync(secret, 'utf8')).toBe('fixture secret\n')
  })

  it.skipIf(process.platform !== 'linux')('protects an ignored artifact tree containing a FIFO', () => {
    const target = setup('node_modules/\n')
    const dependency = file(target, 'node_modules/pkg/index.js')
    const fifo = path.join(target, 'node_modules', 'pipe')
    const created = spawnSync('mkfifo', [fifo], { cwd: root, env: { ...FIXTURE_ENV, HOME: home }, encoding: 'utf8' })
    expect(created.status, created.stderr).toBe(0)
    const entry = row(target)
    expect(entry.eligible).toBe(false)
    expect(remove(target, entry, ack(target)).status).not.toBe(0)
    expect(lstatSync(fifo).isFIFO()).toBe(true)
    expect(existsSync(dependency)).toBe(true)
  })

  it('protects an exposed ignored build-output file and shows its exact name to the operator', () => {
    const target = setup('dist/notes.md\n')
    const notes = file(target, 'dist/notes.md', 'irreplaceable fixture notes\n')
    const entry = row(target)
    expect(entry.ignoredEntries).toContainEqual({ path: 'dist/notes.md', kind: 'protected' })
    expect(entry.eligible).toBe(false)
    const human = spawnSync('bun', [CLI, 'inventory', '--repo', repo], {
      cwd: root,
      env: { ...FIXTURE_ENV, HOME: home },
      encoding: 'utf8',
    })
    expect(human.status, human.stderr).toBe(0)
    expect(human.stdout).toContain('dist/notes.md')
    expect(remove(target, entry, ack(target)).status).not.toBe(0)
    expect(readFileSync(notes, 'utf8')).toBe('irreplaceable fixture notes\n')
  })

  it.skipIf(process.platform !== 'linux')(
    'binds exposed individual cache entries to the token and displays each exact filename',
    () => {
      const target = setup('.pytest_cache/README.md\n.pytest_cache/CACHEDIR.TAG\n')
      const first = file(target, '.pytest_cache/README.md', 'first fixture\n')
      const original = row(target)
      expect(original.eligible).toBe(true)
      expect(original.ignoredEntries).toContainEqual({ path: '.pytest_cache/README.md', kind: 'cache' })
      const second = file(target, '.pytest_cache/CACHEDIR.TAG', 'second fixture\n')
      const updated = row(target)
      expect(updated.eligible).toBe(true)
      expect(updated.ignoredEntries).toContainEqual({ path: '.pytest_cache/README.md', kind: 'cache' })
      expect(updated.ignoredEntries).toContainEqual({ path: '.pytest_cache/CACHEDIR.TAG', kind: 'cache' })
      expect(updated.token).not.toBe(original.token)
      const human = spawnSync('bun', [CLI, 'inventory', '--repo', repo], {
        cwd: root,
        env: { ...FIXTURE_ENV, HOME: home },
        encoding: 'utf8',
      })
      expect(human.status, human.stderr).toBe(0)
      expect(human.stdout).toContain('.pytest_cache/README.md')
      expect(human.stdout).toContain('.pytest_cache/CACHEDIR.TAG')
      expect(remove(target, original, ack(target)).status).not.toBe(0)
      expect(readFileSync(first, 'utf8')).toBe('first fixture\n')
      expect(readFileSync(second, 'utf8')).toBe('second fixture\n')
    },
  )

  it('protects nested working and bare Git repositories inside an ignored artifact directory', () => {
    const target = setup('node_modules/\n')
    const nested = path.join(target, 'node_modules', 'nested')
    initRepo(nested, home)
    git(nested, home, 'checkout', '-q', '-b', 'fixture-unique')
    file(nested, 'committed.txt', 'unique commit\n')
    git(nested, home, 'add', 'committed.txt')
    git(nested, home, 'commit', '-q', '-m', 'unique fixture')
    const head = git(nested, home, 'rev-parse', 'HEAD').trim()
    file(nested, 'README.md', 'stashed fixture\n')
    git(nested, home, 'stash', 'push', '-q', '-m', 'fixture stash')
    const stash = git(nested, home, 'rev-parse', 'refs/stash').trim()
    const working = file(nested, 'working.txt', 'working fixture\n')
    const bare = path.join(target, 'node_modules', 'nested-bare.git')
    git(nested, home, 'clone', '-q', '--bare', nested, bare)
    const entry = row(target)
    expect(entry.eligible).toBe(false)
    expect(remove(target, entry, ack(target)).status).not.toBe(0)
    expect(git(nested, home, 'rev-parse', 'refs/heads/fixture-unique').trim()).toBe(head)
    expect(git(nested, home, 'rev-parse', 'refs/stash').trim()).toBe(stash)
    expect(git(bare, home, 'rev-parse', 'refs/heads/fixture-unique').trim()).toBe(head)
    expect(readFileSync(working, 'utf8')).toBe('working fixture\n')
  })

  it.skipIf(process.platform !== 'linux')('protects a nested linked worktree with a .git file', () => {
    const target = setup('.venv/\n')
    const external = path.join(root, 'external-repo')
    initRepo(external, home)
    const nested = path.join(target, '.venv', 'src', 'linked')
    mkdirSync(path.dirname(nested), { recursive: true })
    git(external, home, 'worktree', 'add', '-q', '-b', 'fixture-linked', nested)
    const head = git(external, home, 'rev-parse', 'refs/heads/fixture-linked').trim()
    const working = file(nested, 'unique.txt', 'linked working fixture\n')
    expect(lstatSync(path.join(nested, '.git')).isFile()).toBe(true)
    const entry = row(target)
    expect(entry.eligible).toBe(false)
    expect(remove(target, entry, ack(target)).status).not.toBe(0)
    expect(readFileSync(working, 'utf8')).toBe('linked working fixture\n')
    expect(git(external, home, 'rev-parse', 'refs/heads/fixture-linked').trim()).toBe(head)
  })

  it('protects a nested bare repository even without a nested working repository', () => {
    const target = setup('dist/\n')
    mkdirSync(path.join(target, 'dist'))
    const bare = path.join(target, 'dist', 'nested-bare.git')
    git(repo, home, 'clone', '-q', '--bare', repo, bare)
    git(bare, home, 'branch', 'fixture-bare-only')
    const head = git(bare, home, 'rev-parse', 'refs/heads/fixture-bare-only').trim()
    const entry = row(target)
    expect(entry.eligible).toBe(false)
    expect(remove(target, entry, ack(target)).status).not.toBe(0)
    expect(git(bare, home, 'rev-parse', 'refs/heads/fixture-bare-only').trim()).toBe(head)
  })

  it.each(['untracked', 'tracked'])('preserves %s changes even alongside recognized ignored artifacts', (kind) => {
    const target = setup('node_modules/\n')
    file(target, 'node_modules/pkg/index.js')
    const retained =
      kind === 'tracked' ? file(target, 'README.md', 'changed\n') : file(target, 'dist/untracked.txt', 'untracked\n')
    const entry = row(target)
    expect(entry.localChanges?.[kind as 'tracked' | 'untracked']).toBeGreaterThan(0)
    expect(entry.eligible).toBe(false)
    expect(remove(target, entry, ack(target)).status).not.toBe(0)
    expect(readFileSync(retained, 'utf8')).toBe(kind === 'tracked' ? 'changed\n' : 'untracked\n')
  })

  it.skipIf(process.platform !== 'linux').each(['added', 'removed'])(
    'rejects a token when an ignored artifact root is %s after inventory',
    (change) => {
      const target = setup('node_modules/\ndist/\n')
      file(target, 'node_modules/pkg/index.js')
      if (change === 'removed') file(target, 'dist/index.html')
      const original = row(target)
      expect(original.eligible).toBe(true)
      if (change === 'added') file(target, 'dist/index.html')
      else rmSync(path.join(target, 'dist'), { recursive: true })
      const updated = row(target)
      expect(updated.eligible).toBe(true)
      expect(updated.token).not.toBe(original.token)
      expect(remove(target, original, ack(target)).status).not.toBe(0)
      expect(existsSync(path.join(target, 'node_modules/pkg/index.js'))).toBe(true)
    },
  )

  it('rejects remove-only, duplicate and unnecessary artifact acknowledgments', () => {
    const target = setup()
    const clean = row(target)
    expect(clean.eligible).toBe(true)
    expect(clean.ignoredEntries).toEqual([])
    expect(clean.requiresArtifactConfirmation).toBe(false)
    expect(command(['inventory', '--repo', repo, ...ack(target)]).status).not.toBe(0)
    expect(remove(target, clean, [...ack(target), ...ack(target)]).status).not.toBe(0)
    expect(remove(target, clean, ack(target)).status).not.toBe(0)
    expect(existsSync(path.join(target, 'README.md'))).toBe(true)
  })

  it.skipIf(process.platform !== 'linux')('keeps usage acknowledgment independent from artifact acknowledgment', () => {
    const target = setup('node_modules/\n')
    file(target, 'node_modules/pkg/index.js')
    const entry = row(target)
    expect(entry.eligible).toBe(true)
    expect(entry.requiresArtifactConfirmation).toBe(true)
    if (entry.requiresUsageConfirmation) {
      expect(remove(target, entry, ack(target), false).status).not.toBe(0)
      expect(remove(target, entry, [], true).status).not.toBe(0)
      expect(remove(target, entry, [...ack(target), '--ack-unknown-usage', `${target}-other`], false).status).not.toBe(
        0,
      )
    } else {
      expect(remove(target, entry, ['--ack-unknown-usage', target], false).status).not.toBe(0)
      expect(remove(target, entry, [...ack(target), '--ack-unknown-usage', target], false).status).not.toBe(0)
    }
    expect(existsSync(path.join(target, 'node_modules/pkg/index.js'))).toBe(true)
  })

  it('does not let artifact acknowledgment override an active process', async () => {
    const target = setup('node_modules/\n')
    file(target, 'node_modules/pkg/index.js')
    const child = spawn('sleep', ['60'], { cwd: target, stdio: 'ignore' })
    try {
      await once(child, 'spawn')
      const entry = row(target)
      expect(entry.activity).toBe('active')
      expect(entry.eligible).toBe(false)
      expect(remove(target, entry, ack(target)).status).not.toBe(0)
      expect(existsSync(path.join(target, 'node_modules/pkg/index.js'))).toBe(true)
    } finally {
      child.kill()
      await once(child, 'exit')
    }
  })

  it.skipIf(process.platform !== 'linux')('does not follow a symlink from an ignored subtree to outside data', () => {
    const target = setup('node_modules/\n')
    const outside = file(root, 'outside/keep', 'outside data\n')
    mkdirSync(path.join(target, 'node_modules'))
    symlinkSync(path.dirname(outside), path.join(target, 'node_modules', 'external'))
    const entry = row(target)
    expect(entry.eligible).toBe(true)
    expect(entry.requiresArtifactConfirmation).toBe(true)
    const result = remove(target, entry, ack(target))
    expect(result.status, result.stderr || result.stdout).toBe(0)
    expect(existsSync(target)).toBe(false)
    expect(readFileSync(outside, 'utf8')).toBe('outside data\n')
  })
})
