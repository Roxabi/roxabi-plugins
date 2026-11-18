import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import type {
  ContextEffectIntent,
  ContextLocalFileObservation,
  ContextLocalFileState,
} from '../engine/context-effect-review-schema.ts'
import {
  closeQuiet,
  type DirectoryPin,
  ensureAncestry,
  errno,
  type Identity,
  identityOf,
  observationFlags,
  type ParsedAbsolutePath,
  recheckDirectoryPin,
  sameIdentity,
} from './context-local-file-path.ts'

export type PathBaseline = { file: Identity | null; state: ContextLocalFileState }
type Resource = ContextEffectIntent['resources'][number]
type SampleOk = ContextLocalFileObservation
type SampleErr = { reason: string }
type RegularFileState = Extract<ContextLocalFileState, { kind: 'regular-file' }>
type Markers = { modifiedNs: string; changedNs: string; size: bigint; mode: number }
const MODE_MASK = 0o7777n
function modeOf(stat: fs.BigIntStats): number {
  return Number(stat.mode & MODE_MASK)
}
function markersOf(stat: fs.BigIntStats): Markers {
  return { modifiedNs: String(stat.mtimeNs), changedNs: String(stat.ctimeNs), size: stat.size, mode: modeOf(stat) }
}
function sameMarkers(a: Markers, b: Markers): boolean {
  return a.modifiedNs === b.modifiedNs && a.changedNs === b.changedNs && a.size === b.size && a.mode === b.mode
}

function hashRegularFd(
  fd: number,
  expectedBytes: number,
  buffer: Buffer,
): { ok: true; sha256: string; bytes: number } | SampleErr {
  const hash = createHash('sha256')
  let total = 0
  for (;;) {
    const n = fs.readSync(fd, buffer, 0, buffer.length, null)
    if (n === 0) break
    total += n
    if (total > expectedBytes) return { reason: 'expected-size-mismatch' }
    hash.update(buffer.subarray(0, n))
  }
  return total === expectedBytes
    ? { ok: true, sha256: hash.digest('hex'), bytes: total }
    : { reason: 'expected-size-mismatch' }
}

function leafOpenReason(error: unknown): SampleErr {
  const code = errno(error)
  if (code === 'ELOOP' || code === 'EMLINK') return { reason: 'leaf-symlink' }
  if (code === 'ENOENT') return { reason: 'expected-present-but-absent' }
  if (code === 'EACCES' || code === 'EPERM') return { reason: 'leaf-unreadable' }
  return { reason: `leaf-open-failed:${code ?? 'error'}` }
}

function absenceFailure(path: string): SampleErr | null {
  try {
    const stat = fs.lstatSync(path, { bigint: true })
    return { reason: stat.isSymbolicLink() ? 'leaf-symlink' : 'expected-absent-but-present' }
  } catch (error) {
    const code = errno(error)
    if (code === 'ENOENT') return null
    return {
      reason: code === 'EACCES' || code === 'EPERM' ? 'leaf-unreadable' : `leaf-lstat-failed:${code ?? 'error'}`,
    }
  }
}

function regularLeafBeforeOpen(path: string): fs.BigIntStats | SampleErr {
  const stat = fs.lstatSync(path, { bigint: true })
  if (stat.isSymbolicLink()) return { reason: 'leaf-symlink' }
  return stat.isFile() ? stat : { reason: 'leaf-not-regular' }
}

function openedRegularFailure(before: fs.BigIntStats, pre: fs.BigIntStats, expected: RegularFileState): string | null {
  if (!before.isFile()) return 'leaf-not-regular'
  if (before.dev !== pre.dev || before.ino !== pre.ino) return 'identity-drift'
  if (Number(before.size) !== expected.bytes) return 'expected-size-mismatch'
  return modeOf(before) === expected.mode ? null : 'expected-mode-mismatch'
}

function regularSampleDrift(
  before: fs.BigIntStats,
  after: fs.BigIntStats,
  named: fs.BigIntStats,
  beforeMarkers: Markers,
): string | null {
  if (!after.isFile() || !named.isFile() || named.isSymbolicLink())
    return named.isSymbolicLink() ? 'leaf-symlink' : 'leaf-not-regular'
  if (after.dev !== before.dev || after.ino !== before.ino || named.dev !== before.dev || named.ino !== before.ino)
    return 'identity-drift'
  if (!sameMarkers(beforeMarkers, markersOf(after)) || !sameMarkers(beforeMarkers, markersOf(named)))
    return 'state-drift'
  return null
}

function baselineDrift(baseline: PathBaseline | undefined, identity: Identity, state: RegularFileState): string | null {
  if (baseline?.file && !sameIdentity(baseline.file, identity)) return 'identity-drift'
  if (baseline?.state.kind === 'absent') return 'state-drift'
  if (
    baseline?.state.kind === 'regular-file' &&
    (baseline.state.sha256 !== state.sha256 ||
      baseline.state.bytes !== state.bytes ||
      baseline.state.mode !== state.mode)
  )
    return 'state-drift'
  return null
}

function presentFailure(error: unknown, fd: number | undefined, parentPin: DirectoryPin): SampleErr {
  if (fd === undefined && errno(error) === 'ENOENT')
    return { reason: recheckDirectoryPin(parentPin) ?? 'expected-present-but-absent' }
  return leafOpenReason(error)
}

function observeAbsent(
  resource: Resource,
  parsed: ParsedAbsolutePath,
  parentPin: DirectoryPin,
  namespaceId: string,
  ancestry: ContextLocalFileObservation['ancestry'],
  baseline: PathBaseline | undefined,
): SampleOk | SampleErr {
  const drift = recheckDirectoryPin(parentPin)
  if (drift !== null) return { reason: drift }
  const absent = absenceFailure(parsed.absolutePath)
  if (absent !== null) return absent
  const parentStill = recheckDirectoryPin(parentPin)
  if (parentStill !== null) return { reason: parentStill }
  const stillAbsent = absenceFailure(parsed.absolutePath)
  if (stillAbsent !== null) return stillAbsent
  if (baseline?.file) return { reason: 'identity-drift' }
  if (baseline && baseline.state.kind !== 'absent') return { reason: 'state-drift' }
  return {
    key: resource.key,
    namespaceId,
    absolutePath: resource.absolutePath,
    canonicalParent: parsed.parent,
    leaf: parsed.leaf,
    ancestry,
    file: null,
    state: { kind: 'absent' },
  }
}

function observePresent(
  resource: Resource,
  expected: RegularFileState,
  parsed: ParsedAbsolutePath,
  parentPin: DirectoryPin,
  namespaceId: string,
  ancestry: ContextLocalFileObservation['ancestry'],
  baseline: PathBaseline | undefined,
  buffer: Buffer,
): SampleOk | SampleErr {
  if (observationFlags === null) return { reason: 'file-observation-capability-unavailable' }
  const parentDrift = recheckDirectoryPin(parentPin)
  if (parentDrift !== null) return { reason: parentDrift }
  let fd: number | undefined
  try {
    const pre = regularLeafBeforeOpen(parsed.absolutePath)
    if ('reason' in pre) return pre
    fd = fs.openSync(parsed.absolutePath, observationFlags.file)
    const before = fs.fstatSync(fd, { bigint: true })
    const openedFailure = openedRegularFailure(before, pre, expected)
    if (openedFailure !== null) return { reason: openedFailure }
    const beforeMarkers = markersOf(before)
    const hashed = hashRegularFd(fd, expected.bytes, buffer)
    if ('reason' in hashed) return hashed
    if (hashed.sha256 !== expected.sha256) return { reason: 'expected-hash-mismatch' }
    const drift = regularSampleDrift(
      before,
      fs.fstatSync(fd, { bigint: true }),
      fs.lstatSync(parsed.absolutePath, { bigint: true }),
      beforeMarkers,
    )
    if (drift !== null) return { reason: drift }
    const endParent = recheckDirectoryPin(parentPin)
    if (endParent !== null) return { reason: endParent }
    const fileIdentity = identityOf(before)
    const state: RegularFileState = {
      kind: 'regular-file',
      sha256: hashed.sha256,
      bytes: hashed.bytes,
      mode: modeOf(before),
    }
    const baselineMismatch = baselineDrift(baseline, fileIdentity, state)
    if (baselineMismatch !== null) return { reason: baselineMismatch }
    return {
      key: resource.key,
      namespaceId,
      absolutePath: resource.absolutePath,
      canonicalParent: parsed.parent,
      leaf: parsed.leaf,
      ancestry,
      file: { identity: fileIdentity, modifiedNs: beforeMarkers.modifiedNs, changedNs: beforeMarkers.changedNs },
      state,
    }
  } catch (error) {
    return presentFailure(error, fd, parentPin)
  } finally {
    if (fd !== undefined) closeQuiet(fd)
  }
}

export function sampleNamedResource(input: {
  resource: Resource
  parsed: ParsedAbsolutePath
  namespaceId: string
  retained: Map<string, DirectoryPin>
  baselines: Map<string, PathBaseline>
  buffer: Buffer
}): SampleOk | SampleErr {
  if (input.resource.basis !== 'accept-named-state') return { reason: 'basis-unsupported' }
  const ancestryOpened = ensureAncestry(input.parsed.dirs, input.retained)
  if ('reason' in ancestryOpened) return ancestryOpened
  const ancestry = ancestryOpened.pins.map((pin) => ({ path: pin.path, identity: { ...pin.identity } }))
  const parentPin = ancestryOpened.pins.at(-1)
  if (!parentPin) return { reason: 'ancestry-missing' }
  const baseline = input.baselines.get(input.resource.absolutePath)
  const sampled =
    input.resource.expected.kind === 'absent'
      ? observeAbsent(input.resource, input.parsed, parentPin, input.namespaceId, ancestry, baseline)
      : observePresent(
          input.resource,
          input.resource.expected,
          input.parsed,
          parentPin,
          input.namespaceId,
          ancestry,
          baseline,
          input.buffer,
        )
  if (!('key' in sampled)) return sampled
  for (const pin of ancestryOpened.pins) {
    const drift = recheckDirectoryPin(pin)
    if (drift !== null) return { reason: drift }
  }
  if (!input.baselines.has(input.resource.absolutePath)) {
    input.baselines.set(input.resource.absolutePath, {
      file: sampled.file === null ? null : { ...sampled.file.identity },
      state: { ...sampled.state },
    })
  }
  return sampled
}
