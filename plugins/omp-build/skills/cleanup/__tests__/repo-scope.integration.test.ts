import { cpSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { commonDir, git, initRepo, scan, scanRaw, scanStatus } from './fixture'

/**
 * #622: the orphan-shell scan feeds `rm -rf` (per-row confirm) and `rmdir`
 * (`--yes`). It must never offer another repository's work, the operator's
 * tracked files, or a path reached through a symlink, and `--yes-targets` must
 * name nothing but proven-empty real directories.
 */

let root: string | undefined

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
})

function tempRoot(tag: string): { root: string; home: string; base: string } {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), `omp-build-622-${tag}-`)))
  const home = path.join(root, 'home')
  mkdirSync(home)
  return { root, home, base: path.join(root, 'wt') }
}

const pathOf = (line: string) => line.split('|')[0]
/** Kinds of the rows naming exactly `p`. */
const kinds = (lines: string[], p: string) =>
  lines.map((line) => line.split('|')).flatMap(([rowPath, kind]) => (rowPath === p ? [kind] : []))
/** Rows naming `p` or anything below it. */
const mentions = (lines: string[], p: string) =>
  lines.filter((line) => pathOf(line) === p || pathOf(line).startsWith(`${p}/`))

/** The `--yes` contract: every row is an empty_parent naming an empty, symlink-free real dir. */
function expectAllowlisted(yesTargets: string[]): void {
  for (const line of yesTargets) {
    expect(line.split('|')[1]).toBe('empty_parent')
    expect(realpathSync(pathOf(line))).toBe(pathOf(line))
    expect(readdirSync(pathOf(line))).toEqual([])
  }
}

describe('cleanup orphan scan repo scope (#622)', () => {
  it('never lists a live worktree of another same-named repository', () => {
    const { root, home, base } = tempRoot('same')
    const orgA = path.join(root, 'orgA', 'app')
    const orgB = path.join(root, 'orgB', 'app')
    initRepo(orgA, home)
    initRepo(orgB, home)
    const foreignLive = path.join(base, 'app', 'feat-7-operator-work')
    mkdirSync(path.dirname(foreignLive), { recursive: true })
    git(orgA, home, 'worktree', 'add', '-q', foreignLive, '-b', 'feat/7-operator-work')
    writeFileSync(path.join(foreignLive, 'NOTES.md'), 'uncommitted\n')
    const ourContent = path.join(base, 'app', 'feat-9-leftover')
    mkdirSync(path.join(ourContent, 'node_modules'), { recursive: true })
    const ourEmpty = path.join(base, 'app', 'feat-9-empty')
    mkdirSync(ourEmpty)

    const env = { HOME: home, OMP_WORKTREE_DIR: base }
    const full = scan(orgB, env)
    const yesTargets = scan(orgB, env, ['--yes-targets'])

    expect(mentions(full, foreignLive)).toEqual([])
    expect(kinds(full, ourContent)).toEqual(['unregistered'])
    expect(yesTargets.map(pathOf)).toEqual([ourEmpty])
    expectAllowlisted(yesTargets)
  })

  it('never lists the principal or its tracked descendants when base is the principal parent', () => {
    const { root, home } = tempRoot('principal')
    const projects = path.join(root, 'projects')
    const principal = path.join(projects, 'app')
    initRepo(principal, home)
    mkdirSync(path.join(principal, 'src'))
    writeFileSync(path.join(principal, 'src', 'main.ts'), 'export {}\n')
    mkdirSync(path.join(principal, 'node_modules', 'leftpad'), { recursive: true })
    const harness = path.join(principal, '.claude', 'worktrees', '495-optional-tail')
    mkdirSync(path.join(harness, 'node_modules'), { recursive: true })
    const emptyOk = path.join(home, '.omp', 'worktrees', 'app', 'empty-ok')
    mkdirSync(emptyOk, { recursive: true })

    const env = { HOME: home, OMP_WORKTREE_DIR: projects }
    const full = scan(principal, env)
    const yesTargets = scan(principal, env, ['--yes-targets'])

    expect(full.filter((line) => pathOf(line) === principal)).toEqual([])
    expect(mentions(full, path.join(principal, 'src'))).toEqual([])
    expect(mentions(full, path.join(principal, 'node_modules'))).toEqual([])
    expect(kinds(full, harness)).toEqual(['inside_worktree'])
    expect(yesTargets.map(pathOf)).toEqual([emptyOk])
  })

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

  it('ownership proof holds when scanning from a subdirectory of the principal', () => {
    const { root, home, base } = tempRoot('subdir')
    const orgA = path.join(root, 'orgA', 'app')
    const orgB = path.join(root, 'orgB', 'app')
    initRepo(orgA, home)
    initRepo(orgB, home)
    mkdirSync(path.join(orgB, 'src'))
    const foreignLive = path.join(base, 'app', 'feat-7-foreign')
    mkdirSync(path.dirname(foreignLive), { recursive: true })
    git(orgA, home, 'worktree', 'add', '-q', foreignLive, '-b', 'feat/7-foreign')
    const oursStale = path.join(base, 'app', 'feat-8-ours-stale')
    git(orgB, home, 'worktree', 'add', '-q', oursStale, '-b', 'feat/8-ours-stale')
    rmSync(path.join(commonDir(orgB, home), 'worktrees'), { recursive: true, force: true })

    const full = scan(path.join(orgB, 'src'), { HOME: home, OMP_WORKTREE_DIR: base })

    expect(mentions(full, foreignLive)).toEqual([])
    expect(full.some((line) => pathOf(line) === oursStale && line.includes('has .git'))).toBe(true)
  })

  it('lists a relative-paths half-removed worktree after worktrees/ is fully pruned', () => {
    const { root, home, base } = tempRoot('rel')
    const repo = path.join(root, 'app')
    initRepo(repo, home)
    git(repo, home, 'config', 'worktree.useRelativePaths', 'true')
    const stale = path.join(base, 'app', 'feat-rel-stale')
    mkdirSync(path.dirname(stale), { recursive: true })
    git(repo, home, 'worktree', 'add', '--relative-paths', '-q', stale, '-b', 'feat/rel-stale')
    rmSync(path.join(commonDir(repo, home), 'worktrees'), { recursive: true, force: true })

    const full = scan(repo, { HOME: home, OMP_WORKTREE_DIR: base })
    expect(full.some((line) => pathOf(line) === stale && line.includes('has .git'))).toBe(true)
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

  it('never lists a base child that contains the principal', () => {
    const { root, home } = tempRoot('contains')
    const projects = path.join(root, 'projects')
    const principal = path.join(projects, 'app', 'org', 'app')
    initRepo(principal, home)
    const container = path.join(projects, 'app', 'org')
    mkdirSync(path.join(container, 'extra'))
    writeFileSync(path.join(container, 'extra', 'x'), 'x\n')
    const emptySibling = path.join(projects, 'app', 'empty-ok')
    mkdirSync(emptySibling)

    const env = { HOME: home, OMP_WORKTREE_DIR: projects }
    const full = scan(principal, env)
    expect(mentions(full, container)).toEqual([])
    expect(scan(principal, env, ['--yes-targets']).map(pathOf)).toEqual([emptySibling])
  })

  it('marks a copy of a live worktree of this repo as inside_worktree, never rm -rf-able', () => {
    // Its `.git` names this repo's live `worktrees/<id>`: ownership is proven,
    // but git still resolves it as a work tree, so it is live work, not a shell.
    const { root, home, base } = tempRoot('copy')
    const repo = path.join(root, 'app')
    initRepo(repo, home)
    const live = path.join(root, 'elsewhere', 'feat-2-live')
    mkdirSync(path.dirname(live), { recursive: true })
    git(repo, home, 'worktree', 'add', '-q', live, '-b', 'feat/2-live')
    const copy = path.join(base, 'app', 'feat-2-copy')
    mkdirSync(copy, { recursive: true })
    cpSync(path.join(live, '.git'), path.join(copy, '.git'))
    writeFileSync(path.join(copy, 'wip.md'), 'wip\n')
    const emptyOk = path.join(base, 'app', 'empty-ok')
    mkdirSync(emptyOk)

    const full = scan(repo, { HOME: home, OMP_WORKTREE_DIR: base })
    expect(kinds(full, copy)).toEqual(['inside_worktree'])
    expect(kinds(full, emptyOk)).toEqual(['empty_parent'])
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

  it('does not emit an empty legacy root inside the principal', () => {
    const { root, home } = tempRoot('empty-root')
    const principal = path.join(root, 'app')
    initRepo(principal, home)
    const legacy = path.join(principal, '.omp-legacy', 'worktrees', 'app')
    mkdirSync(legacy, { recursive: true })
    const emptyOk = path.join(root, 'wt-elsewhere', 'app', 'empty-ok')
    mkdirSync(emptyOk, { recursive: true })

    const env = {
      HOME: home,
      OMP_WORKTREES_ROOT: path.join(principal, '.omp-legacy', 'worktrees'),
      OMP_WORKTREE_DIR: path.join(root, 'wt-elsewhere'),
    }
    expect(mentions(scan(principal, env), legacy)).toEqual([])
    expect(scan(principal, env, ['--yes-targets']).map(pathOf)).toEqual([emptyOk])
  })

  it('lists untracked in-principal feature-base children as inside_worktree, never selectable', () => {
    const { root, home } = tempRoot('inprin')
    const principal = path.join(root, 'app')
    initRepo(principal, home)
    const orphan = path.join(principal, 'app', 'feat-in')
    mkdirSync(path.join(orphan, 'node_modules'), { recursive: true })
    const emptyInPrincipal = path.join(principal, 'app', 'feat-empty')
    mkdirSync(emptyInPrincipal)
    const nonExempt = path.join(principal, 'src')
    mkdirSync(nonExempt)
    writeFileSync(path.join(nonExempt, 'leak.ts'), 'export {}\n')
    const emptyOk = path.join(home, '.omp', 'worktrees', 'app', 'empty-ok')
    mkdirSync(emptyOk, { recursive: true })

    const env = { HOME: home, OMP_WORKTREE_DIR: principal }
    const full = scan(principal, env)
    expect(kinds(full, orphan)).toEqual(['inside_worktree'])
    expect(kinds(full, emptyInPrincipal)).toEqual(['inside_worktree'])
    expect(mentions(full, nonExempt)).toEqual([])
    expect(scan(principal, env, ['--yes-targets']).map(pathOf)).toEqual([emptyOk])
  })

  it('never lists a tracked in-principal feature base or tracked harness root', () => {
    const { root, home } = tempRoot('tracked-base')
    const principal = path.join(root, 'app')
    initRepo(principal, home)
    const tracked = path.join(principal, 'app')
    mkdirSync(path.join(tracked, 'pkg'), { recursive: true })
    writeFileSync(path.join(tracked, 'pkg', '__init__.py'), '')
    const trackedHarness = path.join(principal, '.claude', 'worktrees', 'kept')
    mkdirSync(trackedHarness, { recursive: true })
    writeFileSync(path.join(trackedHarness, 'README.md'), 'tracked\n')
    git(principal, home, 'add', 'app', '.claude')
    git(principal, home, 'commit', '-q', '-m', 'chore: package')
    mkdirSync(path.join(principal, '.claude', 'worktrees', 'untracked-empty'))
    mkdirSync(path.join(tracked, 'untracked-empty'))
    mkdirSync(path.join(principal, '.dev'))
    writeFileSync(path.join(principal, '.dev', 'stack.yml'), 'worktree:\n  base: .\n')
    const emptyOk = path.join(home, '.omp', 'worktrees', 'app', 'empty-ok')
    mkdirSync(emptyOk, { recursive: true })

    const full = scan(principal, { HOME: home })
    expect(mentions(full, principal)).toEqual([])
    expect(kinds(full, emptyOk)).toEqual(['empty_parent'])
  })

  it('rejects unknown arguments with exit 2', () => {
    const { root, home, base } = tempRoot('args')
    const repo = path.join(root, 'app')
    initRepo(repo, home)
    const r = scanStatus(repo, { HOME: home, OMP_WORKTREE_DIR: base }, ['--yes-target'])
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/unknown arg: --yes-target/)
  })

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

  it('marks children of a same-named foreign checkout at <base>/<name> as inside_worktree', () => {
    const { root, home, base } = tempRoot('foreign-co')
    const orgB = path.join(root, 'orgB', 'app')
    initRepo(orgB, home)
    const foreignCheckout = path.join(base, 'app')
    initRepo(foreignCheckout, home)
    mkdirSync(path.join(foreignCheckout, 'src'))
    writeFileSync(path.join(foreignCheckout, 'src', 'wip.ts'), 'export const wip = 1\n')
    mkdirSync(path.join(foreignCheckout, 'empty-in-foreign'))
    const legacyEmpty = path.join(home, '.omp', 'worktrees', 'app', 'empty-ok')
    mkdirSync(legacyEmpty, { recursive: true })

    const env = { HOME: home, OMP_WORKTREE_DIR: base }
    const full = scan(orgB, env)
    expect(kinds(full, path.join(foreignCheckout, 'src'))).toEqual(['inside_worktree'])
    expect(kinds(full, path.join(foreignCheckout, 'empty-in-foreign'))).toEqual(['inside_worktree'])
    expect(scan(orgB, env, ['--yes-targets']).map(pathOf)).toEqual([legacyEmpty])
  })

  it('marks a content-only parent of a nested foreign worktree as nested_git', () => {
    const { root, home, base } = tempRoot('nested')
    const orgA = path.join(root, 'orgA', 'app')
    const orgB = path.join(root, 'orgB', 'app')
    initRepo(orgA, home)
    initRepo(orgB, home)
    const parent = path.join(base, 'app', 'feat')
    const nestedLive = path.join(parent, '7-live')
    mkdirSync(parent, { recursive: true })
    git(orgA, home, 'worktree', 'add', '-q', nestedLive, '-b', 'feat/7-live')
    writeFileSync(path.join(nestedLive, 'NOTES.md'), 'wip\n')
    const emptyOk = path.join(base, 'app', 'empty-ok')
    mkdirSync(emptyOk)

    const env = { HOME: home, OMP_WORKTREE_DIR: base }
    const full = scan(orgB, env)
    expect(kinds(full, parent)).toEqual(['nested_git'])
    expect(scan(orgB, env, ['--yes-targets']).map(pathOf)).toEqual([emptyOk])
  })

  it('base `..` from <principal>/tests lists nothing under the principal, even a tracked <repo>/<repo>/', () => {
    const { root, home } = tempRoot('dotdot')
    const principal = path.join(root, 'projects', 'foo')
    initRepo(principal, home)
    mkdirSync(path.join(principal, 'tests'))
    const trackedNested = path.join(principal, 'foo')
    mkdirSync(path.join(trackedNested, 'sub'), { recursive: true })
    writeFileSync(path.join(trackedNested, '__init__.py'), '')
    writeFileSync(path.join(trackedNested, 'sub', 'x.py'), 'x = 1\n')
    git(principal, home, 'add', 'foo')
    git(principal, home, 'commit', '-q', '-m', 'chore: nested')
    mkdirSync(path.join(principal, '.dev'))
    writeFileSync(path.join(principal, '.dev', 'stack.yml'), 'worktree:\n  base: ..\n')
    const emptyOk = path.join(home, '.omp', 'worktrees', 'foo', 'empty-ok')
    mkdirSync(emptyOk, { recursive: true })

    const full = scan(path.join(principal, 'tests'), { HOME: home })
    expect(mentions(full, principal)).toEqual([])
    expect(kinds(full, emptyOk)).toEqual(['empty_parent'])
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
