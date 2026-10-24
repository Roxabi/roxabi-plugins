import { chmodSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { git, initRepo, scan } from './fixture'
import { cleanupRepoScope, kinds, mentions, pathOf, tempRoot } from './repo-scope.fixture'

afterEach(cleanupRepoScope)

/** Split from repo-scope.integration.test.ts; each case retains the real scanner and filesystem boundary. */
describe('cleanup orphan scan repo scope (#622)', () => {
  it('reports a tracked .claude/worktrees -> ../../.. as symlink_root and lists nothing from $HOME', () => {
    const { home, base } = tempRoot('symroot')
    mkdirSync(path.join(home, 'Documents'))
    writeFileSync(path.join(home, 'Documents', 'notes.txt'), 'keep\n')
    mkdirSync(path.join(home, 'Pictures'))
    const principal = path.join(home, 'projects', 'app')
    initRepo(principal, home)
    mkdirSync(path.join(principal, '.claude'))
    const harnessRoot = path.join(principal, '.claude', 'worktrees')
    symlinkSync(path.join('..', '..', '..'), harnessRoot)
    git(principal, home, 'add', '.claude/worktrees')
    git(principal, home, 'commit', '-q', '-m', 'chore: link')
    expect(realpathSync(harnessRoot)).toBe(home)
    const emptyOk = path.join(base, 'app', 'empty-ok')
    mkdirSync(emptyOk, { recursive: true })

    const env = { HOME: home, OMP_WORKTREE_DIR: base }
    const full = scan(principal, env)
    const yesTargets = scan(principal, env, ['--yes-targets'])

    expect(kinds(full, harnessRoot)).toEqual(['symlink_root'])
    expect(mentions(full, harnessRoot).map(pathOf)).toEqual([harnessRoot])
    expect(full.filter((line) => /Documents|Pictures/.test(line))).toEqual([])
    expect(yesTargets.map(pathOf)).toEqual([emptyOk])
  })
  it('reports a feature base reached through a tracked in-principal symlink as symlink_root', () => {
    const { root, home, base } = tempRoot('symbase')
    const principal = path.join(root, 'app')
    initRepo(principal, home)
    mkdirSync(path.join(base, 'app', 'Pictures'), { recursive: true })
    symlinkSync(base, path.join(principal, 'wt-link'))
    git(principal, home, 'add', 'wt-link')
    git(principal, home, 'commit', '-q', '-m', 'chore: link')
    mkdirSync(path.join(principal, '.dev'))
    writeFileSync(path.join(principal, '.dev', 'stack.yml'), 'worktree:\n  base: wt-link\n')
    const emptyOk = path.join(home, '.omp', 'worktrees', 'app', 'empty-ok')
    mkdirSync(emptyOk, { recursive: true })

    const full = scan(principal, { HOME: home })
    const featureRoot = path.join(principal, 'wt-link', 'app')
    expect(kinds(full, featureRoot)).toEqual(['symlink_root'])
    expect(mentions(full, featureRoot).map(pathOf)).toEqual([featureRoot])
    expect(scan(principal, { HOME: home }, ['--yes-targets']).map(pathOf)).toEqual([emptyOk])
  })
  it('resolves a relative worktree.base against the principal, not the cwd', () => {
    const { root, home } = tempRoot('relbase')
    const principal = path.join(root, 'projects', 'foo')
    initRepo(principal, home)
    mkdirSync(path.join(principal, 'tests'))
    mkdirSync(path.join(principal, '.dev'))
    writeFileSync(path.join(principal, '.dev', 'stack.yml'), 'worktree:\n  base: ../wt\n')
    const orphan = path.join(root, 'projects', 'wt', 'foo', 'feat-1-empty')
    mkdirSync(orphan, { recursive: true })

    const yesTargets = scan(path.join(principal, 'tests'), { HOME: home }, ['--yes-targets'])
    expect(yesTargets.map(pathOf)).toEqual([orphan])
  })
  it('X3: symlinked $HOME still finds the default ~/.omp/wt/<repo>/feat-x orphan', () => {
    const { root } = tempRoot('x3')
    const realHome = path.join(root, 'real-home')
    const home = path.join(root, 'home')
    mkdirSync(realHome)
    rmSync(home, { recursive: true, force: true })
    symlinkSync(realHome, home)
    const repo = path.join(root, 'repo')
    initRepo(repo, home)
    const orphan = path.join(home, '.omp', 'wt', 'repo', 'feat-x')
    mkdirSync(orphan, { recursive: true })

    // No OMP_WORKTREE_DIR — default base is ~/.omp/wt
    const yesTargets = scan(repo, { HOME: home }, ['--yes-targets'])
    expect(yesTargets.map(pathOf).map((p) => realpathSync(p))).toContain(realpathSync(orphan))
  })
  it('X5: stack.yml base: ~/wt expands against $HOME', () => {
    const { root, home } = tempRoot('x5')
    const principal = path.join(root, 'app')
    initRepo(principal, home)
    mkdirSync(path.join(principal, '.dev'))
    writeFileSync(path.join(principal, '.dev', 'stack.yml'), 'worktree:\n  base: ~/wt\n')
    const orphan = path.join(home, 'wt', 'app', 'feat-tilde')
    mkdirSync(orphan, { recursive: true })

    expect(scan(principal, { HOME: home }, ['--yes-targets']).map(pathOf)).toEqual([orphan])
  })
  it('falls back to python3 when PATH has a realpath that rejects -m', () => {
    const { root, base } = tempRoot('nognu')
    const realHome = path.join(root, 'real-home')
    const homeLink = path.join(root, 'home-link')
    mkdirSync(realHome)
    symlinkSync(realHome, homeLink)
    // Use the symlinked home so lexical vs physical still matters under the shim.
    const repo = path.join(root, 'repo')
    initRepo(repo, homeLink)
    const orphan = path.join(base, 'repo', 'feat-shim')
    mkdirSync(orphan, { recursive: true })
    // Relative base under principal
    mkdirSync(path.join(repo, 'tests'), { recursive: true })
    mkdirSync(path.join(repo, '.dev'))
    writeFileSync(path.join(repo, '.dev', 'stack.yml'), `worktree:\n  base: ${base}\n`)

    // Symlinked harness root → $HOME: only a physical canon sees the redirect.
    writeFileSync(path.join(repo, '.gitignore'), '.claude/\n')
    git(repo, homeLink, 'add', '.gitignore')
    git(repo, homeLink, 'commit', '-q', '-m', 'chore: ignore claude')
    mkdirSync(path.join(repo, '.claude'))
    const harnessRoot = path.join(repo, '.claude', 'worktrees')
    symlinkSync(homeLink, harnessRoot)
    mkdirSync(path.join(homeLink, 'Documents'), { recursive: true })
    writeFileSync(path.join(homeLink, 'Documents', 'notes.txt'), 'keep\n')

    const shimDir = path.join(root, 'shim')
    mkdirSync(shimDir)
    // realpath that accepts no -m / -ms flags
    writeFileSync(
      path.join(shimDir, 'realpath'),
      `#!/bin/bash
for a in "$@"; do case "$a" in -m|-ms) echo realpath-no-m >&2; exit 1;; esac; done
exec /usr/bin/realpath "$@"
`,
    )
    chmodSync(path.join(shimDir, 'realpath'), 0o755)

    const env = { HOME: homeLink, PATH: `${shimDir}:${process.env.PATH}`, OMP_WORKTREE_DIR: base }
    const full = scan(repo, env)
    const yesTargets = scan(repo, env, ['--yes-targets'])
    expect(kinds(full, harnessRoot)).toEqual(['symlink_root'])
    expect(full.filter((line) => /Documents/.test(line))).toEqual([])
    expect(yesTargets.map(pathOf)).toEqual([orphan])

    // Relative base against principal still works under the shim
    writeFileSync(path.join(repo, '.dev', 'stack.yml'), 'worktree:\n  base: ../wt-rel\n')
    const relOrphan = path.join(root, 'wt-rel', 'repo', 'feat-rel')
    mkdirSync(relOrphan, { recursive: true })
    mkdirSync(path.join(repo, 'tests'), { recursive: true })
    const yesRel = scan(path.join(repo, 'tests'), { HOME: homeLink, PATH: `${shimDir}:${process.env.PATH}` }, [
      '--yes-targets',
    ])
    expect(yesRel.map(pathOf)).toEqual([relOrphan])
  })
})
