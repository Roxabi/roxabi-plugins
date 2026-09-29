import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
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

  it('never offers the principal or its tracked descendants when base is the principal parent (harness orphans stay per-row)', () => {
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
    expect(kinds(full, harness)).toEqual(['unregistered'])
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

  it('never lists a checkout whose gitdir is this repo but not under its worktrees/', () => {
    // A `.git` pointing at `<common>/modules/…` (a submodule work tree) is not a
    // worktree shell, even though it names this repository's git dir.
    const { root, home, base } = tempRoot('modules')
    const repo = path.join(root, 'app')
    initRepo(repo, home)
    const common = commonDir(repo, home)
    mkdirSync(path.join(common, 'modules', 'vendored'), { recursive: true })
    const sub = path.join(base, 'app', 'vendored')
    mkdirSync(sub, { recursive: true })
    writeFileSync(path.join(sub, '.git'), `gitdir: ${path.join(common, 'modules', 'vendored')}\n`)
    const emptyOk = path.join(base, 'app', 'empty-ok')
    mkdirSync(emptyOk)

    const full = scan(repo, { HOME: home, OMP_WORKTREE_DIR: base })
    expect(mentions(full, sub)).toEqual([])
    expect(kinds(full, emptyOk)).toEqual(['empty_parent'])
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

  it('never lists a base child that contains a registered worktree of this repo', () => {
    const { root, home, base } = tempRoot('contains-reg')
    const repo = path.join(root, 'app')
    initRepo(repo, home)
    const holder = path.join(base, 'app', 'feat')
    const live = path.join(holder, '7-ours')
    mkdirSync(holder, { recursive: true })
    git(repo, home, 'worktree', 'add', '-q', live, '-b', 'feat/7-ours')
    writeFileSync(path.join(holder, 'notes.txt'), 'wip\n')
    const emptyOk = path.join(base, 'app', 'empty-ok')
    mkdirSync(emptyOk)

    const full = scan(repo, { HOME: home, OMP_WORKTREE_DIR: base })
    expect(mentions(full, holder)).toEqual([])
    expect(kinds(full, emptyOk)).toEqual(['empty_parent'])
  })

  it('never lists anything under a registered worktree sitting at <base>/<repo>', () => {
    const { root, home, base } = tempRoot('under-reg')
    const repo = path.join(root, 'app')
    initRepo(repo, home)
    const live = path.join(base, 'app')
    mkdirSync(base, { recursive: true })
    git(repo, home, 'worktree', 'add', '-q', live, '-b', 'feat/8-at-root')
    mkdirSync(path.join(live, 'scratch'))
    writeFileSync(path.join(live, 'scratch', 'wip.md'), 'wip\n')
    mkdirSync(path.join(live, 'empty-in-live'))
    const emptyOk = path.join(home, '.omp', 'worktrees', 'app', 'empty-ok')
    mkdirSync(emptyOk, { recursive: true })

    const full = scan(repo, { HOME: home, OMP_WORKTREE_DIR: base })
    expect(mentions(full, live)).toEqual([])
    expect(kinds(full, emptyOk)).toEqual(['empty_parent'])
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

  it('lists untracked in-principal feature-base children as per-row kinds, never in --yes-targets', () => {
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
    expect(kinds(full, orphan)).toEqual(['unregistered'])
    expect(kinds(full, emptyInPrincipal)).toEqual(['empty_untracked'])
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

  it("marks a foreign checkout's tracked src as inside_worktree; untracked empty is empty_untracked", () => {
    const { root, home, base } = tempRoot('foreign-co')
    const orgB = path.join(root, 'orgB', 'app')
    initRepo(orgB, home)
    const foreignCheckout = path.join(base, 'app')
    initRepo(foreignCheckout, home)
    mkdirSync(path.join(foreignCheckout, 'src'))
    writeFileSync(path.join(foreignCheckout, 'src', 'wip.ts'), 'export const wip = 1\n')
    git(foreignCheckout, home, 'add', 'src')
    git(foreignCheckout, home, 'commit', '-q', '-m', 'chore: src')
    mkdirSync(path.join(foreignCheckout, 'empty-in-foreign'))
    const legacyEmpty = path.join(home, '.omp', 'worktrees', 'app', 'empty-ok')
    mkdirSync(legacyEmpty, { recursive: true })

    const env = { HOME: home, OMP_WORKTREE_DIR: base }
    const full = scan(orgB, env)
    expect(kinds(full, path.join(foreignCheckout, 'src'))).toEqual(['inside_worktree'])
    expect(kinds(full, path.join(foreignCheckout, 'empty-in-foreign'))).toEqual(['empty_untracked'])
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

  it('lists a half-removed harness .git shell as unregistered (X14)', () => {
    const { root, home } = tempRoot('x14')
    const principal = path.join(root, 'app')
    initRepo(principal, home)
    const half = path.join(principal, '.claude', 'worktrees', 'feat-half')
    mkdirSync(path.dirname(half), { recursive: true })
    git(principal, home, 'worktree', 'add', '-q', half, '-b', 'feat/half')
    rmSync(path.join(commonDir(principal, home), 'worktrees'), { recursive: true, force: true })
    const emptyOk = path.join(home, '.omp', 'worktrees', 'app', 'empty-ok')
    mkdirSync(emptyOk, { recursive: true })

    const env = { HOME: home, OMP_WORKTREE_DIR: path.join(root, 'wt') }
    const full = scan(principal, env)
    expect(kinds(full, half)).toEqual(['unregistered'])
    expect(full.some((line) => pathOf(line) === half && line.includes('has .git'))).toBe(true)
    expect(scan(principal, env, ['--yes-targets']).map(pathOf)).toEqual([emptyOk])
  })

  it('lists empty and node_modules-only harness children as per-row kinds', () => {
    const { root, home } = tempRoot('harness-orphans')
    const principal = path.join(root, 'app')
    initRepo(principal, home)
    const empty = path.join(principal, '.claude', 'worktrees', 'orphan-empty')
    mkdirSync(empty, { recursive: true })
    const nm = path.join(principal, '.claude', 'worktrees', 'orphan-nm')
    mkdirSync(path.join(nm, 'node_modules'), { recursive: true })
    const emptyOk = path.join(home, '.omp', 'worktrees', 'app', 'empty-ok')
    mkdirSync(emptyOk, { recursive: true })

    const env = { HOME: home, OMP_WORKTREE_DIR: path.join(root, 'wt') }
    const full = scan(principal, env)
    expect(kinds(full, empty)).toEqual(['empty_untracked'])
    expect(kinds(full, nm)).toEqual(['unregistered'])
    expect(scan(principal, env, ['--yes-targets']).map(pathOf)).toEqual([emptyOk])
  })

  it('scans a gitignored in-principal feature base (ls-files empty -> exempt)', () => {
    const { root, home } = tempRoot('gitignore-base')
    const principal = path.join(root, 'app')
    initRepo(principal, home)
    writeFileSync(path.join(principal, '.gitignore'), 'app/\n')
    git(principal, home, 'add', '.gitignore')
    git(principal, home, 'commit', '-q', '-m', 'chore: ignore')
    mkdirSync(path.join(principal, '.dev'))
    writeFileSync(path.join(principal, '.dev', 'stack.yml'), 'worktree:\n  base: .\n')
    const content = path.join(principal, 'app', 'feat-ig')
    mkdirSync(path.join(content, 'node_modules'), { recursive: true })
    const empty = path.join(principal, 'app', 'feat-ig-empty')
    mkdirSync(empty, { recursive: true })
    const emptyOk = path.join(home, '.omp', 'worktrees', 'app', 'empty-ok')
    mkdirSync(emptyOk, { recursive: true })

    const full = scan(principal, { HOME: home })
    expect(kinds(full, content)).toEqual(['unregistered'])
    expect(kinds(full, empty)).toEqual(['empty_untracked'])
    expect(scan(principal, { HOME: home }, ['--yes-targets']).map(pathOf)).toEqual([emptyOk])
  })

  it('under a $HOME dotfiles repo with .gitignore=*, empty orphans are empty_untracked not --yes', () => {
    const { root, home, base } = tempRoot('dotfiles')
    initRepo(home, home)
    writeFileSync(path.join(home, '.gitignore'), '*\n')
    git(home, home, 'add', '-f', '.gitignore')
    git(home, home, 'commit', '-q', '-m', 'chore: ignore-all')
    const principal = path.join(root, 'projects', 'app')
    initRepo(principal, home)
    const legacyEmpty = path.join(home, '.omp', 'worktrees', 'app', 'feat-x')
    mkdirSync(legacyEmpty, { recursive: true })
    const outsideEmpty = path.join(base, 'app', 'outside-empty')
    mkdirSync(outsideEmpty, { recursive: true })

    const env = { HOME: home, OMP_WORKTREE_DIR: base }
    const full = scan(principal, env)
    expect(kinds(full, legacyEmpty)).toEqual(['empty_untracked'])
    expect(kinds(full, outsideEmpty)).toEqual(['empty_parent'])
    expect(scan(principal, env, ['--yes-targets']).map(pathOf)).toEqual([outsideEmpty])
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
      expect(yesTargets.map(pathOf)).toEqual([emptyOk])
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

  it('falls back to python3 when PATH has a realpath that rejects -m', () => {
    const { root, home, base } = tempRoot('nognu')
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

    const shimDir = path.join(root, 'shim')
    mkdirSync(shimDir)
    // realpath that accepts no -m / -ms flags
    writeFileSync(
      path.join(shimDir, 'realpath'),
      [
        '#!/bin/bash',
        'for a in "$@"; do case "$a" in -m|-ms) echo realpath-no-m >&2; exit 1;; esac; done',
        'exec /usr/bin/realpath "$@"',
      ].join('\n') + '\n',
    )
    chmodSync(path.join(shimDir, 'realpath'), 0o755)

    const env = { HOME: homeLink, PATH: `${shimDir}:${process.env.PATH}`, OMP_WORKTREE_DIR: base }
    const yesTargets = scan(repo, env, ['--yes-targets'])
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
