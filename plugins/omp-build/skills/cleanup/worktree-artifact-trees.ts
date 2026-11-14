import { type Dirent, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { type IgnoredEntry, inside, type Row } from './worktree-shared'

type Scan = { worktree: string; dev: bigint; seen: Set<string> }

// Next to `HEAD`, any of these names marks a possible Git directory (bare, linked-worktree admin or reftable layout).
const gitDirectoryMarkers = ['objects', 'refs', 'packed-refs', 'reftable', 'commondir']
const label = (scan: Scan, path: string) => JSON.stringify(relative(scan.worktree, path) || '.')
// Filesystem errors embed raw paths; re-raise them with the quoted relative path and the error code only.
function observe<T>(scan: Scan, path: string, read: () => T): T {
  try {
    return read()
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code || 'error'
    throw new Error(`cannot inspect ignored artifact ${label(scan, path)}: ${code}`)
  }
}

// Decodes the mount point field of /proc/<pid>/mountinfo (proc_pid_mountinfo(5)); a malformed line throws.
function parseMountPoints(mountinfo: string): string[] {
  const points: string[] = []
  for (const line of mountinfo.split('\n')) {
    if (!line) continue
    const fields = line.split(' ')
    const separator = fields.indexOf('-', 6)
    if (!/^\d+ \d+ \d+:\d+ \S+ \/\S* \S+/.test(line) || separator < 0 || fields.length < separator + 4)
      throw new Error(`malformed mountinfo line: ${JSON.stringify(line)}`)
    points.push(fields[4].replace(/\\([0-7]{3})/g, (_, code: string) => String.fromCharCode(Number.parseInt(code, 8))))
  }
  return points
}
// Mount points, including file and same-device bind mounts, at or below `path`. Unsupported or unreadable throws.
function mountPointsWithin(path: string): string[] {
  if (process.platform !== 'linux') throw new Error('mount table inspection is unsupported on this platform')
  return parseMountPoints(readFileSync('/proc/self/mountinfo', 'utf8')).filter((point) => inside(path, point))
}
function entryType(scan: Scan, entry: Dirent, path: string): 'directory' | 'leaf' | 'special' {
  if (entry.isDirectory()) return 'directory'
  if (entry.isFile() || entry.isSymbolicLink()) return 'leaf'
  const stat = observe(scan, path, () => lstatSync(path))
  if (stat.isDirectory()) return 'directory'
  return stat.isFile() || stat.isSymbolicLink() ? 'leaf' : 'special'
}
// Reads one directory's names and no-follow metadata. Returns a finding, or the subdirectories to visit next.
function visitDirectory(scan: Scan, dir: string): string | string[] {
  const before = observe(scan, dir, () => lstatSync(dir, { bigint: true }))
  if (!before.isDirectory()) return `ignored artifact is not a real directory: ${label(scan, dir)}`
  if (before.dev !== scan.dev) return `mount point in ignored artifact: ${label(scan, dir)}`
  const identity = `${before.dev}:${before.ino}`
  if (scan.seen.has(identity)) return `repeated directory identity in ignored artifact: ${label(scan, dir)}`
  scan.seen.add(identity)
  const entries = observe(scan, dir, () => readdirSync(dir, { withFileTypes: true }))
  const after = observe(scan, dir, () => lstatSync(dir, { bigint: true }))
  if (!after.isDirectory() || after.dev !== before.dev || after.ino !== before.ino)
    return `ignored artifact changed during inspection: ${label(scan, dir)}`
  const names = new Set(entries.map((entry) => entry.name))
  if (names.has('HEAD') && gitDirectoryMarkers.some((name) => names.has(name)))
    return `possible bare Git repository in ignored artifact: ${label(scan, dir)}`
  const children: string[] = []
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.name === '.git') return `nested Git repository in ignored artifact: ${label(scan, path)}`
    const type = entryType(scan, entry, path)
    if (type === 'directory') children.push(path)
    else if (type === 'special') return `special file in ignored artifact: ${label(scan, path)}`
  }
  return children
}
// Git reported the entry; its ancestors and the entry itself must still be real directories or a regular file, observed
// without following symlinks. A directory entry is walked iteratively.
function entryFinding(scan: Scan, entry: IgnoredEntry): string | null {
  const segments = entry.path.replace(/\/$/, '').split('/')
  for (let index = 1; index < segments.length; index++) {
    const ancestor = join(scan.worktree, ...segments.slice(0, index))
    if (!observe(scan, ancestor, () => lstatSync(ancestor)).isDirectory())
      return `ignored artifact ancestor is not a real directory: ${label(scan, ancestor)}`
  }
  const target = join(scan.worktree, ...segments)
  if (!entry.path.endsWith('/')) {
    const regular = observe(scan, target, () => lstatSync(target)).isFile()
    return regular ? null : `ignored artifact is not a regular file: ${label(scan, target)}`
  }
  const stack = [target]
  while (stack.length) {
    const visited = visitDirectory(scan, stack.pop() as string)
    if (typeof visited === 'string') return visited
    for (const child of visited) stack.push(child)
  }
  return null
}
// `git worktree remove` deletes nested repositories (their refs, stashes and worktrees) and recurses through mounts, so
// an otherwise removable row with recognized artifacts is kept on the first nested Git directory, mount, special file,
// replaced directory or unsupported observation. Names and metadata only: file contents, `HEAD` and Git configuration
// are never read, and the walk does not prove that content can be regenerated. Observation errors propagate to the
// caller. One pass is not atomic: writers and mount changes must be stopped before selection.
function inspectArtifactTrees(row: Row) {
  const entries = row.ignoredEntries.filter((entry) => entry.kind !== 'protected')
  if (!entries.length) return
  if (process.platform !== 'linux') {
    row.reasons.push('mount table inspection is unsupported on this platform; ignored artifacts are kept')
    return
  }
  const mounts = mountPointsWithin(row.path)
  if (mounts.length) {
    row.reasons.push(`mount point at or below worktree: ${JSON.stringify(relative(row.path, mounts[0]) || '.')}`)
    return
  }
  const scan: Scan = { worktree: row.path, dev: 0n, seen: new Set() }
  scan.dev = observe(scan, row.path, () => lstatSync(row.path, { bigint: true })).dev
  for (const entry of entries) {
    const finding = entryFinding(scan, entry)
    if (finding) {
      row.reasons.push(finding)
      return
    }
  }
}

export { inspectArtifactTrees, mountPointsWithin, parseMountPoints }
