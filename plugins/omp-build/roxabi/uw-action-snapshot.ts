import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { Result } from '../engine/result.ts'
import type { ActionSnapshot } from './uw-action-contract.ts'
import { actionFailure } from './uw-action-result.ts'

type SealedEntry = {
  readonly path: string
  readonly kind: 'file' | 'directory' | 'symlink' | 'other'
  readonly bytes: Uint8Array | null
}

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
    entries.push({ path: file.path, kind: 'file', bytes: file.bytes })
  }
  for (const path of directories) entries.push({ path, kind: 'directory', bytes: null })
  return entries
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

export type ActionSnapshotClaim = {
  readonly id: string
  readonly actionId: string
  readonly manifestDigest: string
  readonly indexPath: string
  readonly location: ActionSnapshot['location']
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
  return { ok: true, value: sealedHandle(claim, intended) }
}

export function snapshotOutsideRoot(indexPath: string, root: string): boolean {
  const relativePath = relative(resolve(root), resolve(indexPath))
  return relativePath.startsWith('..') || relativePath.split(sep).includes('..')
}
