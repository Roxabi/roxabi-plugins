import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { commonDir, git, initRepo, scan, scanRaw, scanStatus } from './fixture'
import { cleanupRepoScope, expectAllowlisted, kinds, mentions, pathOf, tempRoot } from './repo-scope.fixture'

afterEach(cleanupRepoScope)

/** Split from repo-scope.integration.test.ts; each case retains the real scanner and filesystem boundary. */
describe('cleanup orphan scan repo scope (#622)', () => {
  it('--yes-targets allowlists only proven-empty dirs: content and half-removed worktrees stay out', () => {
    const { root, home, base } = tempRoot('yes')
    const repo = path.join(root, 'app')
    initRepo(repo, home)
    const staleGit = path.join(base, 'app', 'feat-3-stale-git')
    mkdirSync(path.dirname(staleGit), { recursive: true })
    git(repo, home, 'worktree', 'add', '-q', staleGit, '-b', 'feat/3-stale-git')
    rmSync(path.join(commonDir(repo, home), 'worktrees'), { recursive: true, force: true })
    const emptyOrphan = path.join(base, 'app', 'feat-4-empty')
    mkdirSync(emptyOrphan)
    const contentOrphan = path.join(base, 'app', 'feat-5-content')
    mkdirSync(path.join(contentOrphan, 'node_modules'), { recursive: true })

    const env = { HOME: home, OMP_WORKTREE_DIR: base }
    const full = scan(repo, env)
    const yesTargets = scan(repo, env, ['--yes-targets'])

    expect(full.some((line) => pathOf(line) === staleGit && line.includes('has .git'))).toBe(true)
    expect(kinds(full, contentOrphan)).toEqual(['unregistered'])
    expect(yesTargets.map(pathOf)).toEqual([emptyOrphan])
    expectAllowlisted(yesTargets)
  })
  it('shows a symlink child as symlink and never follows it', () => {
    const { root, home, base } = tempRoot('symlink')
    const outside = path.join(root, 'important')
    mkdirSync(outside)
    const repo = path.join(root, 'app')
    initRepo(repo, home)
    const linkChild = path.join(base, 'app', 'linkchild')
    mkdirSync(path.dirname(linkChild), { recursive: true })
    symlinkSync(outside, linkChild)
    const emptyOrphan = path.join(base, 'app', 'feat-empty')
    mkdirSync(emptyOrphan)

    const env = { HOME: home, OMP_WORKTREE_DIR: base }
    const full = scan(repo, env)
    const yesTargets = scan(repo, env, ['--yes-targets'])

    expect(kinds(full, linkChild)).toEqual(['symlink'])
    expect(mentions(full, outside)).toEqual([])
    expect(yesTargets.map(pathOf)).toEqual([emptyOrphan])
  })
  it('shows a dangling .git with content as dangling_git, never selectable', () => {
    const { root, home, base } = tempRoot('dangling')
    const repo = path.join(root, 'app')
    initRepo(repo, home)
    const shell = path.join(base, 'app', 'feat-6-dangling')
    mkdirSync(path.join(shell, 'src'), { recursive: true })
    writeFileSync(path.join(shell, 'src', 'wip.ts'), 'export {}\n')
    symlinkSync(path.join(root, 'gone', '.git'), path.join(shell, '.git'))
    const emptyOk = path.join(base, 'app', 'empty-ok')
    mkdirSync(emptyOk)

    const env = { HOME: home, OMP_WORKTREE_DIR: base }
    expect(kinds(scan(repo, env), shell)).toEqual(['dangling_git'])
    expect(scan(repo, env, ['--yes-targets']).map(pathOf)).toEqual([emptyOk])
  })
  it('cannot forge a row: control characters and pipes become one escaped unsafe_name row', () => {
    const { root, home, base } = tempRoot('unsafe')
    const repo = path.join(root, 'app')
    initRepo(repo, home)
    // Both empty: without the guard they are empty_parent, i.e. `rmdir` targets.
    mkdirSync(path.join(base, 'app', 'bad|name'), { recursive: true })
    mkdirSync(path.join(base, 'app', 'x\nsrc'))
    const emptyOk = path.join(base, 'app', 'empty-ok')
    mkdirSync(emptyOk)

    const env = { HOME: home, OMP_WORKTREE_DIR: base }
    const rawFull = scanRaw(repo, env)
    const rawYes = scanRaw(repo, env, ['--yes-targets'])
    const fullLines = rawFull.split('\n').filter((line) => line !== '')

    // Every row is exactly three fields; a name can neither add a row nor a field.
    for (const line of fullLines) expect(line.split('|')).toHaveLength(3)
    expect(fullLines.some((line) => line.startsWith('src|') || pathOf(line) === 'src')).toBe(false)
    const pipeRows = fullLines.filter((line) => line.includes('bad'))
    expect(pipeRows.map((line) => line.split('|')[1])).toEqual(['unsafe_name'])
    const nlRows = fullLines.filter((line) => line.includes('src'))
    expect(nlRows.map((line) => line.split('|')[1])).toEqual(['unsafe_name'])
    const yesLines = rawYes.split('\n').filter((line) => line !== '')
    for (const line of yesLines) expect(line.startsWith('/')).toBe(true)
    expect(yesLines.map(pathOf)).toEqual([emptyOk])
  })
  it('rejects unknown arguments with exit 2', () => {
    const { root, home, base } = tempRoot('args')
    const repo = path.join(root, 'app')
    initRepo(repo, home)
    const r = scanStatus(repo, { HOME: home, OMP_WORKTREE_DIR: base }, ['--yes-target'])
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/unknown arg: --yes-target/)
  })
  it('marks a chmod-000 child holding content as unreadable, never in --yes-targets', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return
    const { root, home, base } = tempRoot('unreadable')
    const repo = path.join(root, 'app')
    initRepo(repo, home)
    const locked = path.join(base, 'app', 'feat-locked')
    mkdirSync(path.join(locked, 'src'), { recursive: true })
    writeFileSync(path.join(locked, 'src', 'notes.md'), 'secret\n')
    chmodSync(locked, 0o000)
    const emptyOk = path.join(base, 'app', 'empty-ok')
    mkdirSync(emptyOk)
    try {
      const env = { HOME: home, OMP_WORKTREE_DIR: base }
      const full = scan(repo, env)
      const yesTargets = scan(repo, env, ['--yes-targets'])
      expect(kinds(full, locked)).toEqual(['unreadable'])
      expect(
        full.some((line) => line.startsWith(`${locked}|unreadable|`) && line.includes('not readable/searchable')),
      ).toBe(true)
      expect(yesTargets.map(pathOf)).toEqual([emptyOk])
    } finally {
      chmodSync(locked, 0o700)
    }
  })
  it('marks a readable child with a chmod-000 descendant as unreadable (find EACCES)', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return
    const { root, home, base } = tempRoot('eacces')
    const repo = path.join(root, 'app')
    initRepo(repo, home)
    const parent = path.join(base, 'app', 'feat-parent')
    const locked = path.join(parent, 'locked')
    mkdirSync(locked, { recursive: true })
    writeFileSync(path.join(locked, 'notes.md'), 'secret\n')
    chmodSync(locked, 0o000)
    const emptyOk = path.join(base, 'app', 'empty-ok')
    mkdirSync(emptyOk)
    try {
      const env = { HOME: home, OMP_WORKTREE_DIR: base }
      const full = scan(repo, env)
      expect(kinds(full, parent)).toEqual(['unreadable'])
      expect(full.some((line) => line.startsWith(`${parent}|unreadable|`) && line.includes('cannot search'))).toBe(true)
      expect(scan(repo, env, ['--yes-targets']).map(pathOf)).toEqual([emptyOk])
    } finally {
      chmodSync(locked, 0o700)
    }
  })
  it('rejects shell-metacharacter names as unsafe_name', () => {
    const { root, home, base } = tempRoot('meta')
    const repo = path.join(root, 'app')
    initRepo(repo, home)
    mkdirSync(path.join(base, 'app'), { recursive: true })
    for (const name of ['bad`tick', 'bad$dir', 'bad"quote', 'bad\\slash']) {
      mkdirSync(path.join(base, 'app', name))
    }
    const emptyOk = path.join(base, 'app', 'empty-ok')
    mkdirSync(emptyOk)

    const env = { HOME: home, OMP_WORKTREE_DIR: base }
    const full = scan(repo, env)
    const unsafe = full.filter((line) => line.includes('|unsafe_name|'))
    expect(unsafe.length).toBe(4)
    expect(scan(repo, env, ['--yes-targets']).map(pathOf)).toEqual([emptyOk])
  })
  it('X7: an empty legacy ~/.omp/worktrees/<repo> root is empty_parent', () => {
    const { root, home } = tempRoot('x7')
    const principal = path.join(root, 'app')
    initRepo(principal, home)
    const legacy = path.join(home, '.omp', 'worktrees', 'app')
    mkdirSync(legacy, { recursive: true })
    // Keep feature root from producing siblings: point it at an empty elsewhere
    const elsewhere = path.join(root, 'elsewhere')
    mkdirSync(path.join(elsewhere, 'app'), { recursive: true })
    writeFileSync(path.join(elsewhere, 'app', '.keep'), '')

    const full = scan(principal, { HOME: home, OMP_WORKTREE_DIR: elsewhere })
    expect(kinds(full, legacy)).toEqual(['empty_parent'])
    expect(scan(principal, { HOME: home, OMP_WORKTREE_DIR: elsewhere }, ['--yes-targets']).map(pathOf)).toEqual([
      legacy,
    ])
  })
  it('X10/X11: a .venv-only child is unregistered, never in --yes-targets', () => {
    const { root, home, base } = tempRoot('x11')
    const repo = path.join(root, 'app')
    initRepo(repo, home)
    const venv = path.join(base, 'app', 'feat-venv')
    mkdirSync(path.join(venv, '.venv', 'bin'), { recursive: true })
    writeFileSync(path.join(venv, '.venv', 'bin', 'python'), '')
    const emptyOk = path.join(base, 'app', 'empty-ok')
    mkdirSync(emptyOk)

    const env = { HOME: home, OMP_WORKTREE_DIR: base }
    expect(kinds(scan(repo, env), venv)).toEqual(['unregistered'])
    expect(scan(repo, env, ['--yes-targets']).map(pathOf)).toEqual([emptyOk])
  })
  it('marks a regular file child as not_a_dir', () => {
    const { root, home, base } = tempRoot('file')
    const repo = path.join(root, 'app')
    initRepo(repo, home)
    mkdirSync(path.join(base, 'app'), { recursive: true })
    const fileChild = path.join(base, 'app', 'README.orphan')
    writeFileSync(fileChild, '')
    const emptyOk = path.join(base, 'app', 'empty-ok')
    mkdirSync(emptyOk)

    const env = { HOME: home, OMP_WORKTREE_DIR: base }
    expect(kinds(scan(repo, env), fileChild)).toEqual(['not_a_dir'])
    expect(scan(repo, env, ['--yes-targets']).map(pathOf)).toEqual([emptyOk])
  })
})
