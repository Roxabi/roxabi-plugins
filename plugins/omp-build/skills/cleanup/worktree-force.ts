import { createHash, type Hash } from 'node:crypto'
import { type BigIntStats, lstatSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { gitDirectoryMarkers, mountPointsWithin } from './worktree-artifact-trees'
import { canonical, git, type Row } from './worktree-shared'

type Walk = { root: string; dev: bigint; seen: Set<string>; hash: Hash }
type Listed = { path: string; stat: BigIntStats }

const label = (walk: Walk, path: string) => JSON.stringify(relative(walk.root, path) || '.')
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
// Filesystem errors embed raw paths; re-raise them with the quoted relative path and the error code only.
function observe<T>(walk: Walk, path: string, read: () => T): T {
  try {
    return read()
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code || 'error'
    throw new Error(`cannot inspect worktree entry ${label(walk, path)}: ${code}`)
  }
}
const lstat = (walk: Walk, path: string) => observe(walk, path, () => lstatSync(path, { bigint: true }))
function fileType(stat: BigIntStats): 'directory' | 'file' | 'symlink' | 'special' {
  if (stat.isDirectory()) return 'directory'
  if (stat.isFile()) return 'file'
  return stat.isSymbolicLink() ? 'symlink' : 'special'
}
// Access time is excluded: the inspection itself reads directories.
function record(walk: Walk, path: string, stat: BigIntStats) {
  const fields = [fileType(stat), stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs]
  walk.hash.update(`${JSON.stringify(relative(walk.root, path))}\t${fields.join('\t')}\n`)
}
const unchanged = (a: BigIntStats, b: BigIntStats) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.mode === b.mode &&
  a.size === b.size &&
  a.mtimeNs === b.mtimeNs &&
  a.ctimeNs === b.ctimeNs
// Only the linked worktree's own root `.git` file is expected; any other `.git` is a nested repository or worktree.
function entryFinding(walk: Walk, parent: string, name: string, path: string, stat: BigIntStats): string | null {
  if (name === '.git' && parent !== walk.root) return `nested Git repository in worktree: ${label(walk, path)}`
  if (name === '.git' && !stat.isFile()) return `worktree .git is not a regular file: ${label(walk, path)}`
  if (fileType(stat) === 'special') return `special file in worktree: ${label(walk, path)}`
  return null
}
// Reads one directory whose metadata was recorded when its parent was listed. Returns a finding, or the
// subdirectories to visit next in name order.
function visitDirectory(walk: Walk, dir: Listed): string | Listed[] {
  const before = lstat(walk, dir.path)
  if (!before.isDirectory() || !unchanged(before, dir.stat))
    return `worktree changed during inspection: ${label(walk, dir.path)}`
  if (before.dev !== walk.dev) return `mount point in worktree: ${label(walk, dir.path)}`
  const identity = `${before.dev}:${before.ino}`
  if (walk.seen.has(identity)) return `repeated directory identity in worktree: ${label(walk, dir.path)}`
  walk.seen.add(identity)
  const listed = observe(walk, dir.path, () => readdirSync(dir.path)).sort(byCodeUnit)
  if (!unchanged(lstat(walk, dir.path), before)) return `worktree changed during inspection: ${label(walk, dir.path)}`
  // Node replaces undecodable name bytes with U+FFFD: such a name is neither stat'ed nor hashed, since it may denote
  // another file. A name genuinely containing U+FFFD is kept too.
  if (listed.some((name) => name.includes('\uFFFD')))
    return `name not representable as UTF-8 in worktree directory: ${label(walk, dir.path)}`
  if (listed.includes('HEAD') && gitDirectoryMarkers.some((name) => listed.includes(name)))
    return `possible bare Git repository in worktree: ${label(walk, dir.path)}`
  const children: Listed[] = []
  for (const name of listed) {
    const path = join(dir.path, name)
    const stat = lstat(walk, path)
    record(walk, path, stat)
    const finding = entryFinding(walk, dir.path, name, path, stat)
    if (finding) return finding
    if (stat.isDirectory()) children.push({ path, stat })
  }
  return children
}
// The root `.git` must be a regular file that Git resolves to an administrative directory of this repository; its
// content is resolved by Git, not read here.
function gitFileFinding(row: Row): string | null {
  const dotGit = lstatSync(join(row.path, '.git'), { throwIfNoEntry: false })
  if (!dotGit?.isFile()) return 'worktree .git is not a regular file'
  const lines = git(row.path, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir').split('\n')
  const adminDir = lines.length === 3 ? canonical(lines[0]) : null
  if (
    adminDir === null ||
    canonical(lines[1]) !== row.commonDir ||
    dirname(adminDir) !== join(row.commonDir, 'worktrees')
  )
    return 'worktree .git does not resolve to an administrative directory of this repository'
  // Git skips its own administrative-submodule check with --force; those repositories can survive deinitialization.
  if (lstatSync(join(adminDir, 'modules'), { throwIfNoEntry: false }))
    return 'submodule repositories retained in the worktree Git directory'
  return null
}
// `git worktree remove --force` deletes everything below the worktree: nested repositories, mounted content and all
// local data. Before a force row becomes removable, the entire worktree, ignored directories included, is walked once
// by name and no-follow metadata; file contents are never read and symlinks are never followed. A mount point (from the
// mount table, so same-device bind mounts count), a nested `.git` of any type, a possible bare repository, a special
// file, an unexpected root `.git`, or a directory that is replaced or changes during the walk keeps the row;
// observation errors propagate. The result is a deterministic fingerprint of every entry's relative path, type, device,
// inode, mode, size, modification and change times, so a content change at an unchanged path and Git status stales the
// force token. One pass is neither atomic nor a content-integrity proof: writers must be stopped before selection.
function inspectForceTree(row: Row): string | null {
  if (process.platform !== 'linux') {
    row.reasons.push('mount table inspection is unsupported on this platform; force removal is refused')
    return null
  }
  const mounts = mountPointsWithin(row.path)
  const finding = mounts.length
    ? `mount point at or below worktree: ${JSON.stringify(relative(row.path, mounts[0]) || '.')}`
    : gitFileFinding(row)
  if (finding) {
    row.reasons.push(finding)
    return null
  }
  const walk: Walk = { root: row.path, dev: 0n, seen: new Set(), hash: createHash('sha256') }
  const root = lstat(walk, row.path)
  walk.dev = root.dev
  record(walk, row.path, root)
  const stack: Listed[] = [{ path: row.path, stat: root }]
  while (stack.length) {
    const visited = visitDirectory(walk, stack.pop() as Listed)
    if (typeof visited === 'string') {
      row.reasons.push(visited)
      return null
    }
    for (let index = visited.length - 1; index >= 0; index--) stack.push(visited[index])
  }
  return walk.hash.digest('hex')
}

export { inspectForceTree }
