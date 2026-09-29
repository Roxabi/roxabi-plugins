import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { git as gitIn, initRepo, scan as scanRepo } from './fixture'

/**
 * #536 F2: the scanner compares a path git gave it against a path it built out
 * of `$HOME`, and `rm -rf` is what happens to the rows it calls orphans. Git
 * records the **resolved** worktree path; `$HOME` is a symlink on any machine
 * whose account lives under an automount, a bind mount, or `/home` → `/Users`.
 * Compared lexically the two spellings differ, a live registered worktree reads
 * as an orphan, and 5b-execute deletes it.
 *
 * The rest of the suite cannot see this class: every other fixture builds its
 * roots from the same string it hands to git, so the two spellings are equal by
 * construction. This one puts a symlink between them, exactly where a real home
 * puts one.
 */
let root: string | undefined

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
})

/**
 * A repo whose `~/.omp/worktrees/<repo>/` root is reached through a symlinked
 * home: one live registered worktree, one registered worktree reached through a
 * symlinked child, and one genuine leftover shell beside them.
 */
function symlinkedHomeFixture(): { repo: string; home: string; live: string; linked: string; orphan: string } {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'omp-build-orphan-')))
  const realHome = path.join(root, 'real-home')
  const home = path.join(root, 'home')
  mkdirSync(realHome)
  symlinkSync(realHome, home)

  const repo = path.join(root, 'repo')
  initRepo(repo, home)
  const git = (...args: string[]) => gitIn(repo, home, ...args)

  // ~/.omp/worktrees is a legacy leftover root the scanner still walks.
  // Git stores the resolved path for the same worktree.
  const wtRoot = path.join(home, '.omp', 'worktrees', 'repo')
  const live = path.join(wtRoot, 'feat-1-live')
  mkdirSync(wtRoot, { recursive: true })
  git('worktree', 'add', '-q', live, '-b', 'feat/1-live')

  // A real leftover: `git worktree remove` took the registration, node_modules stayed.
  const orphan = path.join(wtRoot, 'feat-2-orphan')
  mkdirSync(path.join(orphan, 'node_modules'), { recursive: true })

  // A registered worktree that lives elsewhere and is reached from this root
  // through a symlink — the shape left behind by relocating a worktree. git
  // registered the target; the glob yields the link.
  const elsewhere = path.join(root, 'elsewhere', 'feat-3-moved')
  mkdirSync(path.dirname(elsewhere), { recursive: true })
  git('worktree', 'add', '-q', elsewhere, '-b', 'feat/3-moved')
  const linked = path.join(wtRoot, 'feat-3-link')
  symlinkSync(elsewhere, linked)
  return { repo, home, live, linked, orphan }
}

const scan = (repo: string, home: string) => scanRepo(repo, { HOME: home })

describe('orphan scan under a symlinked home', () => {
  it('never reports a registered worktree as an orphan', () => {
    const { repo, home, live, orphan } = symlinkedHomeFixture()
    const reported = scan(repo, home).map((line) => line.split('|')[0])

    // The live worktree is registered; naming it here is naming a `rm -rf`
    // target. Both spellings are checked because the bug is that they differ.
    expect(reported).not.toContain(live)
    expect(reported).not.toContain(realpathSync(live))
    expect(reported.map((p) => realpathSync(p))).not.toContain(realpathSync(live))

    // …and the scan is not simply silent: the real leftover is still found.
    expect(reported.map((p) => realpathSync(p))).toContain(realpathSync(orphan))
  })

  it('never reports a registered worktree reached through a symlinked child', () => {
    // Same comparison, symlink on the other side: the root is canonical and the
    // entry inside it is the link. Unresolved, it matches no registry key and is
    // offered for `rm -rf` — on a path whose target is a live worktree.
    const { repo, home, linked } = symlinkedHomeFixture()
    const reported = scan(repo, home).map((line) => line.split('|')[0])
    expect(reported).not.toContain(linked)
    expect(reported.map((p) => realpathSync(p))).not.toContain(realpathSync(linked))
  })

  it('emits symlink-free paths under a canonical anchor, the spelling git registers', () => {
    const { repo, home } = symlinkedHomeFixture()
    const reported = scan(repo, home).map((line) => line.split('|')[0])
    expect(reported.length).toBeGreaterThan(0)
    for (const p of reported) expect(p).toBe(realpathSync(p))
  })
})
