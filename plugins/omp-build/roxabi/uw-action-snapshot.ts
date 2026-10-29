import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { Result } from '../engine/result.ts'
import { registerHostActionHandle } from '../omp/review-runtime/action-registry.ts'
import type { ActionSnapshot, ActionSnapshotStore } from './uw-action-contract.ts'
import { actionFailure } from './uw-action-result.ts'

type SealedEntry = {
  readonly path: string
  readonly kind: 'file' | 'directory' | 'symlink' | 'other'
  readonly bytes: Uint8Array | null
}

const baselines = new WeakMap<ActionSnapshot, readonly SealedEntry[]>()

function treeDigest(entries: readonly SealedEntry[]): string {
  const hash = createHash('sha256')
  for (const entry of [...entries].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  )) {
    hash.update(entry.path)
    hash.update('\0')
    hash.update(entry.kind)
    hash.update('\0')
    hash.update(String(entry.bytes?.byteLength ?? 0))
    hash.update('\0')
    if (entry.bytes !== null) hash.update(entry.bytes)
    hash.update('\0')
  }
  return hash.digest('hex')
}

function linkedWorktreeGitDir(cwd: string): string | null {
  try {
    const gitDir = resolve(
      cwd,
      execFileSync('git', ['-C', cwd, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim(),
    )
    const common = resolve(
      cwd,
      execFileSync('git', ['-C', cwd, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim(),
    )
    return gitDir === common ? null : gitDir
  } catch {
    return null
  }
}

function placementRoot(input: {
  artifactsDir?: string | null
  cwd: string
}): Result<{ root: string; location: ActionSnapshot['location'] }> {
  if (input.artifactsDir) {
    const root = join(input.artifactsDir, 'local', 'omp-build', 'actions')
    try {
      mkdirSync(root, { recursive: true, mode: 0o755 })
      return { ok: true, value: { root, location: 'local' } }
    } catch {
      // Fall through to the linked worktree git dir. Never the principal .git.
    }
  }
  const gitDir = linkedWorktreeGitDir(input.cwd)
  if (gitDir === null) {
    return actionFailure(
      'snapshot-placement-unavailable',
      'Neither the local protocol root nor this worktree git dir can hold the action snapshot',
    )
  }
  const root = join(gitDir, 'omp-build', 'actions')
  try {
    mkdirSync(root, { recursive: true, mode: 0o755 })
  } catch (error) {
    return actionFailure(
      'snapshot-placement-unavailable',
      error instanceof Error ? error.message : 'worktree git dir is not writable',
    )
  }
  return { ok: true, value: { root, location: 'worktree-gitdir' } }
}

function writeTree(directory: string, files: readonly { path: string; bytes: Uint8Array }[]): void {
  for (const file of files) {
    const target = join(directory, file.path)
    mkdirSync(dirname(target), { recursive: true, mode: 0o755 })
    writeFileSync(target, file.bytes, { mode: 0o444 })
  }
}

function walk(directory: string, prefix = ''): { path: string; kind: SealedEntry['kind'] }[] {
  const found: { path: string; kind: SealedEntry['kind'] }[] = []
  for (const name of readdirSync(directory)) {
    const absolute = join(directory, name)
    const path = prefix.length === 0 ? name : `${prefix}/${name}`
    const entry = lstatSync(absolute)
    if (entry.isSymbolicLink()) found.push({ path, kind: 'symlink' })
    else if (entry.isDirectory()) {
      found.push({ path, kind: 'directory' })
      found.push(...walk(absolute, path))
    } else found.push({ path, kind: entry.isFile() ? 'file' : 'other' })
  }
  return found
}

function sealEntries(files: readonly { path: string; bytes: Uint8Array }[]): readonly SealedEntry[] {
  const entries: SealedEntry[] = []
  const directories = new Set<string>()
  for (const file of files) {
    const parts = file.path.split('/')
    for (let index = 1; index < parts.length; index += 1) directories.add(parts.slice(0, index).join('/'))
    entries.push({ path: file.path, kind: 'file', bytes: new Uint8Array(file.bytes) })
  }
  for (const path of directories) entries.push({ path, kind: 'directory', bytes: null })
  return Object.freeze(entries.map((entry) => Object.freeze(entry)))
}

function snapshotRoot(directory: string): Result<true> {
  try {
    const rootStat = lstatSync(directory)
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory())
      return actionFailure('snapshot-mutated', 'Snapshot root is not the sealed directory')
    return { ok: true, value: true }
  } catch (error) {
    return actionFailure('snapshot-unreadable', error instanceof Error ? error.message : 'snapshot root is unreadable')
  }
}

function observedTree(directory: string): Result<{ path: string; kind: SealedEntry['kind'] }[]> {
  try {
    return { ok: true, value: walk(directory) }
  } catch (error) {
    return actionFailure(
      'snapshot-unreadable',
      error instanceof Error ? error.message : 'snapshot directory is unreadable',
    )
  }
}

function compareSealedFile(
  directory: string,
  entry: { path: string; kind: SealedEntry['kind'] },
  sealed: SealedEntry | undefined,
): Result<true> {
  if (sealed === undefined || sealed.kind !== entry.kind)
    return actionFailure('snapshot-mutated', `Snapshot entry kind changed: ${entry.path}`)
  if (sealed.kind !== 'file' || sealed.bytes === null) return { ok: true, value: true }
  try {
    const disk = readFileSync(join(directory, entry.path))
    if (Buffer.compare(disk, Buffer.from(sealed.bytes)) !== 0)
      return actionFailure('snapshot-mutated', `Snapshot bytes changed: ${entry.path}`)
  } catch (error) {
    return actionFailure(
      'snapshot-unreadable',
      error instanceof Error ? error.message : `snapshot file is unreadable: ${entry.path}`,
    )
  }
  return { ok: true, value: true }
}

function compareSealedTree(
  directory: string,
  observed: readonly { path: string; kind: SealedEntry['kind'] }[],
  expected: ReadonlyMap<string, SealedEntry>,
): Result<true> {
  if (observed.length !== expected.size)
    return actionFailure('snapshot-mutated', 'Snapshot tree added, deleted, or renamed an entry')
  for (const entry of observed) {
    const compared = compareSealedFile(directory, entry, expected.get(entry.path))
    if (!compared.ok) return compared
  }
  return { ok: true, value: true }
}

export function verifyActionSnapshot(snapshot: ActionSnapshot): Promise<Result<ActionSnapshot>> {
  const baseline = baselines.get(snapshot)
  if (baseline === undefined)
    return Promise.resolve(
      actionFailure('action-handle-unregistered', 'The action snapshot is not a registered host handle'),
    )
  const directory = dirname(snapshot.indexPath)
  const root = snapshotRoot(directory)
  if (!root.ok) return Promise.resolve(root)
  const observed = observedTree(directory)
  if (!observed.ok) return Promise.resolve(observed)
  const compared = compareSealedTree(directory, observed.value, new Map(baseline.map((entry) => [entry.path, entry])))
  if (!compared.ok) return Promise.resolve(compared)
  return Promise.resolve({ ok: true, value: snapshot })
}

export function createActionSnapshotStore(input: { artifactsDir?: string | null; cwd: string }): ActionSnapshotStore {
  return {
    create: async (request) => {
      const placed = placementRoot(input)
      if (!placed.ok) return placed
      const id = randomBytes(16).toString('hex')
      const directory = join(placed.value.root, `${id}-${request.actionId.replace(/[^a-z0-9-]/gi, '')}`)
      try {
        mkdirSync(directory, { recursive: true, mode: 0o755 })
        writeTree(directory, request.files)
      } catch (error) {
        return actionFailure(
          'snapshot-placement-unavailable',
          error instanceof Error ? error.message : 'snapshot write failed',
        )
      }
      return { ok: true, value: { indexPath: join(directory, 'index.md'), location: placed.value.location } }
    },
  }
}

export type ActionSnapshotClaim = {
  readonly id: string
  readonly actionId: string
  readonly manifestDigest: string
  readonly indexPath: string
  readonly location: ActionSnapshot['location']
}

export function intendedSnapshotDigest(files: readonly { path: string; bytes: Uint8Array }[]): string {
  return treeDigest(sealEntries(files))
}

function matchIntendedEntry(
  directory: string,
  entry: { path: string; kind: SealedEntry['kind'] },
  wanted: SealedEntry | undefined,
): Result<true> {
  if (wanted === undefined || wanted.kind !== entry.kind)
    return actionFailure('snapshot-mutated', `Sealed entry kind differs: ${entry.path}`)
  if (wanted.kind !== 'file') return { ok: true, value: true }
  const disk = readFileSync(join(directory, entry.path))
  if (Buffer.compare(disk, Buffer.from(wanted.bytes ?? new Uint8Array())) !== 0)
    return actionFailure('snapshot-mutated', `Sealed bytes differ from the intended file: ${entry.path}`)
  return { ok: true, value: true }
}

function matchIntendedTree(
  directory: string,
  observed: readonly { path: string; kind: SealedEntry['kind'] }[],
  intended: readonly SealedEntry[],
): Result<true> {
  if (observed.length !== intended.length)
    return actionFailure('snapshot-mutated', 'Sealed tree has an unexpected entry')
  const expected = new Map(intended.map((entry) => [entry.path, entry]))
  for (const entry of observed) {
    const matched = matchIntendedEntry(directory, entry, expected.get(entry.path))
    if (!matched.ok) return matched
  }
  return { ok: true, value: true }
}

function sealedHandle(claim: ActionSnapshotClaim, entries: readonly SealedEntry[]): ActionSnapshot {
  return Object.freeze({
    id: claim.id,
    actionId: claim.actionId,
    manifestDigest: claim.manifestDigest,
    indexPath: claim.indexPath,
    location: claim.location,
    integrityDigest: treeDigest(entries),
  })
}

export function sealActionSnapshot(
  claim: ActionSnapshotClaim,
  files: readonly { path: string; bytes: Uint8Array }[],
): Result<ActionSnapshot> {
  const directory = dirname(claim.indexPath)
  const intended = sealEntries(files)
  try {
    const root = snapshotRoot(directory)
    if (!root.ok) return root
    const observed = observedTree(directory)
    if (!observed.ok) return observed
    const matched = matchIntendedTree(directory, observed.value, intended)
    if (!matched.ok) return matched
  } catch (error) {
    return actionFailure('snapshot-unreadable', error instanceof Error ? error.message : 'snapshot seal failed')
  }
  const sealed = Object.freeze(
    intended.map((entry) =>
      Object.freeze({ ...entry, bytes: entry.bytes === null ? null : Uint8Array.from(entry.bytes) }),
    ),
  )
  const handle = sealedHandle(claim, sealed)
  baselines.set(handle, sealed)
  registerHostActionHandle(handle, (registered) => verifyActionSnapshot(registered))
  return { ok: true, value: handle }
}

export function snapshotOutsideRoot(indexPath: string, root: string): boolean {
  const relativePath = relative(resolve(root), resolve(indexPath))
  return relativePath.startsWith('..') || relativePath.split(sep).includes('..')
}
