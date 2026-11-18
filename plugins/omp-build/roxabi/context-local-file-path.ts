import * as fs from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize } from 'node:path'

export type Identity = { device: string; inode: string }
export type DirectoryPin = { path: string; fd: number; identity: Identity }
export type ParsedAbsolutePath = { absolutePath: string; parent: string; leaf: string; dirs: string[] }
type PathFailure = { reason: string }

const requiredFlags = [fs.constants.O_NOFOLLOW, fs.constants.O_DIRECTORY, fs.constants.O_NONBLOCK]
export const observationFlags = requiredFlags.every((flag) => typeof flag === 'number' && flag !== 0)
  ? Object.freeze({
      directory: fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
      file: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    })
  : null

/** Validate the literal platform-native path; do not silently normalize an operator's resource. */
export function parseNamedAbsolutePath(absolutePath: string): ParsedAbsolutePath | PathFailure {
  if (typeof absolutePath !== 'string' || absolutePath.length === 0) return { reason: 'path-malformed' }
  if (absolutePath.includes('\0')) return { reason: 'path-nul' }
  if (absolutePath.includes('://')) return { reason: 'path-internal-url' }
  if (!isAbsolute(absolutePath)) return { reason: 'path-malformed' }
  const parent = dirname(absolutePath)
  const leaf = basename(absolutePath)
  if (parent === absolutePath || leaf.length === 0) return { reason: 'path-malformed' }
  if (normalize(absolutePath) !== absolutePath || join(parent, leaf) !== absolutePath)
    return { reason: 'path-noncanonical' }
  const dirs: string[] = []
  let directory = parent
  for (;;) {
    dirs.push(directory)
    const ancestor = dirname(directory)
    if (ancestor === directory) break
    directory = ancestor
  }
  dirs.reverse()
  return { absolutePath, parent, leaf, dirs }
}

export function closeQuiet(fd: number): void {
  try {
    fs.closeSync(fd)
  } catch {
    // A cleanup failure must not replace the observation's original refusal.
  }
}
export function closeDirectoryPins(pins: Iterable<DirectoryPin>): void {
  for (const pin of pins) closeQuiet(pin.fd)
}
export function sameIdentity(a: Identity, b: Identity): boolean {
  return a.device === b.device && a.inode === b.inode
}
export function identityOf(stat: fs.BigIntStats): Identity {
  return { device: String(stat.dev), inode: String(stat.ino) }
}
export function errno(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : null
}

function directoryOpenFailure(error: unknown): PathFailure {
  const code = errno(error)
  if (code === 'ELOOP' || code === 'EMLINK') return { reason: 'ancestry-symlink' }
  if (code === 'EACCES' || code === 'EPERM') return { reason: 'ancestry-unreadable' }
  if (code === 'ENOENT' || code === 'ENOTDIR') return { reason: 'ancestry-missing' }
  return { reason: `ancestry-unreadable:${code ?? 'error'}` }
}

function openDirectory(path: string): { pin: DirectoryPin } | PathFailure {
  if (observationFlags === null) return { reason: 'file-observation-capability-unavailable' }
  let fd: number | undefined
  try {
    const before = fs.lstatSync(path, { bigint: true })
    if (before.isSymbolicLink()) return { reason: 'ancestry-symlink' }
    if (!before.isDirectory()) return { reason: 'ancestry-not-directory' }
    fd = fs.openSync(path, observationFlags.directory)
    const opened = fs.fstatSync(fd, { bigint: true })
    const named = fs.lstatSync(path, { bigint: true })
    if (
      !opened.isDirectory() ||
      !named.isDirectory() ||
      named.dev !== opened.dev ||
      named.ino !== opened.ino ||
      before.dev !== opened.dev ||
      before.ino !== opened.ino
    ) {
      closeQuiet(fd)
      return { reason: opened.isDirectory() ? 'ancestry-identity-drift' : 'ancestry-not-directory' }
    }
    return { pin: { path, fd, identity: identityOf(opened) } }
  } catch (error) {
    if (fd !== undefined) closeQuiet(fd)
    return directoryOpenFailure(error)
  }
}

export function recheckDirectoryPin(pin: DirectoryPin): string | null {
  try {
    const opened = fs.fstatSync(pin.fd, { bigint: true })
    const named = fs.lstatSync(pin.path, { bigint: true })
    if (!opened.isDirectory() || !named.isDirectory()) return 'ancestry-not-directory'
    if (named.isSymbolicLink()) return 'ancestry-symlink'
    if (!sameIdentity(pin.identity, identityOf(opened)) || !sameIdentity(pin.identity, identityOf(named)))
      return 'ancestry-identity-drift'
    return null
  } catch (error) {
    const code = errno(error)
    return code === 'EACCES' || code === 'EPERM' ? 'ancestry-unreadable' : `ancestry-identity-drift:${code ?? 'error'}`
  }
}

export function ensureAncestry(
  dirs: readonly string[],
  retained: Map<string, DirectoryPin>,
): { pins: DirectoryPin[] } | PathFailure {
  const pins: DirectoryPin[] = []
  const acquired: DirectoryPin[] = []
  const abandon = () => {
    for (const pin of acquired) {
      retained.delete(pin.path)
      closeQuiet(pin.fd)
    }
  }
  try {
    for (const dirPath of dirs) {
      const existing = retained.get(dirPath)
      if (existing) {
        const drift = recheckDirectoryPin(existing)
        if (drift !== null) {
          abandon()
          return { reason: drift }
        }
        pins.push(existing)
        continue
      }
      const opened = openDirectory(dirPath)
      if ('reason' in opened) {
        abandon()
        return opened
      }
      acquired.push(opened.pin)
      retained.set(dirPath, opened.pin)
      pins.push(opened.pin)
    }
    return { pins }
  } catch (error) {
    abandon()
    return { reason: `ancestry-unreadable:${errno(error) ?? 'error'}` }
  }
}
