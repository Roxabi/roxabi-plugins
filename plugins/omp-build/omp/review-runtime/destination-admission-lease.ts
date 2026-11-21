import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { FileLock } from '@oh-my-pi/pi-natives'
import { canonicalValueDigest, destinationSchema } from '../../dist/contracts.js'
import type { AdmissionDescriptor, Destination } from '../../engine/fix-recovery-schema.ts'

const protocol = 'omp-build-destination-mutex/1' as const
export type AdmissionLeaseFailure = Readonly<{
  code:
    | 'unsupported-host'
    | 'invalid-destination'
    | 'namespace-unobservable'
    | 'unsafe-path'
    | 'unsafe-permissions'
    | 'lease-occupied'
    | 'lease-handle-invalid'
    | 'lease-io-unknown'
  message: string
  errno: string | null
}>
declare const admissionBrand: unique symbol
export type DestinationAdmissionLease = Readonly<{ descriptor: AdmissionDescriptor; [admissionBrand]: never }>
type Pinned = { path: string; fd: number; stat: fs.BigIntStats; private: boolean; file: boolean }
type Entry = {
  handle: DestinationAdmissionLease
  native: FileLock
  creator: number
  pins: Pinned[]
  released: boolean
  usable: boolean
}
// A native lock must not be collected while admission is outstanding, including on failure.
const held = new Map<DestinationAdmissionLease, Entry>()
const completed = new WeakSet<DestinationAdmissionLease>()
class Failure extends Error {
  constructor(
    readonly code: AdmissionLeaseFailure['code'],
    message: string,
  ) {
    super(message)
  }
}
function diagnostic(error: unknown): AdmissionLeaseFailure {
  if (error instanceof Failure) return { code: error.code, message: error.message, errno: null }
  const e = error as NodeJS.ErrnoException
  return { code: 'lease-io-unknown', message: e?.message ?? String(error), errno: e?.code ?? null }
}
function closePins(pins: Pinned[]): void {
  for (const pin of pins.reverse()) {
    try {
      fs.closeSync(pin.fd)
    } catch {}
  }
}
function sameIdentity(a: fs.BigIntStats, b: fs.BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino
}
function validate(stat: fs.BigIntStats, uid: number, privatePath: boolean, file: boolean): void {
  if (file ? !stat.isFile() : !stat.isDirectory()) throw new Failure('unsafe-path', 'Mutex path has an unexpected type')
  if (
    file
      ? stat.uid !== BigInt(uid) || (stat.mode & 0o7777n) !== 0o600n || stat.nlink !== 1n
      : privatePath
        ? stat.uid !== BigInt(uid) || (stat.mode & 0o7777n) !== 0o700n
        : (stat.uid !== 0n && stat.uid !== BigInt(uid)) || (stat.mode & 0o022n) !== 0n
  )
    throw new Failure('unsafe-permissions', 'Unsafe mutex path ownership, mode, or link count')
}
function pin(pathname: string, uid: number, privatePath: boolean, file: boolean, create: boolean): Pinned {
  const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (file ? 0 : fs.constants.O_DIRECTORY)
  if (create && !file) {
    try {
      fs.mkdirSync(pathname, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  const fd = fs.openSync(
    pathname,
    file && create ? fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW : flags,
    0o600,
  )
  try {
    const stat = fs.fstatSync(fd, { bigint: true })
    validate(stat, uid, privatePath, file)
    const observed = fs.lstatSync(pathname, { bigint: true })
    validate(observed, uid, privatePath, file)
    if (!sameIdentity(stat, observed)) throw new Failure('unsafe-path', 'Mutex path changed while opening')
    return { path: pathname, fd, stat, private: privatePath, file }
  } catch (error) {
    fs.closeSync(fd)
    throw error
  }
}
function darwinPins(digest: string): { pins: Pinned[]; file: Pinned } {
  if (typeof process.geteuid !== 'function') throw new Failure('unsupported-host', 'Effective UID is unavailable')
  const uid = process.geteuid()
  const accountHome = os.userInfo().homedir
  if (!path.isAbsolute(accountHome)) throw new Failure('unsafe-path', 'OS account home is not absolute')
  const home = fs.realpathSync(accountHome)
  const pins: Pinned[] = []
  try {
    let current = path.parse(home).root
    let homePin = pin(current, uid, false, false, false)
    pins.push(homePin)
    for (const name of home.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, name)
      homePin = pin(current, uid, false, false, false)
      pins.push(homePin)
    }
    if (fs.fstatSync(homePin.fd, { bigint: true }).uid !== BigInt(uid))
      throw new Failure('unsafe-permissions', 'OS account home is not owned by effective UID')
    for (const name of ['.omp-build-execution', 'destination-mutex-v1']) {
      current = path.join(current, name)
      pins.push(pin(current, uid, true, false, true))
    }
    current = path.join(current, `${digest}.lock`)
    const file = pin(current, uid, true, true, true)
    pins.push(file)
    return { pins, file }
  } catch (error) {
    closePins(pins)
    throw error
  }
}
function checkPins(pins: Pinned[]): void {
  const uid = process.geteuid?.()
  if (uid === undefined) throw new Failure('unsupported-host', 'Effective UID is unavailable')
  if (fs.realpathSync(os.userInfo().homedir) !== pins[pins.length - 4]?.path)
    throw new Failure('unsafe-path', 'OS account home changed')
  for (const item of pins) {
    const fd = fs.fstatSync(item.fd, { bigint: true }),
      named = fs.lstatSync(item.path, { bigint: true })
    validate(fd, uid, item.private, item.file)
    validate(named, uid, item.private, item.file)
    if (!sameIdentity(item.stat, fd) || !sameIdentity(fd, named))
      throw new Failure('unsafe-path', 'Pinned mutex path changed')
  }
}
function linuxNetworkNamespace(): string | null {
  try {
    if (
      Number(fs.statfsSync('/proc', { bigint: true }).type) !== 0x9fa0 ||
      fs.readlinkSync('/proc/self') !== String(process.pid)
    )
      return null
    const value = fs.readlinkSync('/proc/self/ns/net')
    return /^net:\[\d+\]$/.test(value) ? value : null
  } catch {
    return null
  }
}
function lookup(lease: DestinationAdmissionLease): Entry {
  const entry = held.get(lease)
  if (!entry || entry.creator !== process.pid || entry.handle !== lease)
    throw new Failure('lease-handle-invalid', 'Unregistered or foreign admission handle')
  return entry
}
function check(entry: Entry): void {
  if (!entry.usable || entry.released || !entry.native.acquired)
    throw new Failure('lease-handle-invalid', 'Admission handle is not held')
  const namespace = entry.handle.descriptor.namespace
  if (namespace.kind === 'linux-abstract' && namespace.networkNamespace !== null) {
    const observed = linuxNetworkNamespace()
    if (observed !== null && observed !== namespace.networkNamespace)
      throw new Failure('namespace-unobservable', 'Linux network namespace changed')
  }
  if (namespace.kind === 'darwin-file') checkPins(entry.pins)
}
export async function acquireDestinationAdmissionLease(
  input: Readonly<{ destination: Destination }>,
): Promise<
  | { status: 'acquired'; lease: DestinationAdmissionLease }
  | { status: 'occupied' | 'refused'; diagnostics: readonly AdmissionLeaseFailure[] }
  | { status: 'uncertain'; retained: DestinationAdmissionLease; diagnostics: readonly AdmissionLeaseFailure[] }
> {
  let pins: Pinned[] = [],
    entry: Entry | undefined
  try {
    const parsed = destinationSchema.safeParse(input.destination)
    if (!parsed.success) throw new Failure('invalid-destination', 'Invalid canonical destination')
    // The Bun-only native loader cannot be evaluated by Node/Vitest during pre-admission imports.
    const { FileLock } = await import('@oh-my-pi/pi-natives')
    const destination = parsed.data
    const destinationDigest = canonicalValueDigest([
      destination.authority,
      destination.publicationRepository,
      destination.destinationRef,
    ])
    let namespace: AdmissionDescriptor['namespace'], key: string
    if (process.platform === 'linux') {
      namespace = { kind: 'linux-abstract', networkNamespace: linuxNetworkNamespace() }
      key = `${protocol}/${destinationDigest}`
    } else if (process.platform === 'win32') {
      namespace = { kind: 'windows-global' }
      key = `${protocol}/${destinationDigest}`
    } else if (process.platform === 'darwin') {
      const pinned = darwinPins(destinationDigest)
      pins = pinned.pins
      checkPins(pins)
      const file = pinned.file
      namespace = { kind: 'darwin-file', path: file.path, device: String(file.stat.dev), inode: String(file.stat.ino) }
      key = file.path
    } else throw new Failure('unsupported-host', `Unsupported platform: ${process.platform}`)
    const descriptor = Object.freeze({
      protocol,
      destinationDigest,
      namespace: Object.freeze(namespace),
    }) as AdmissionDescriptor
    const handle = Object.freeze({ descriptor }) as DestinationAdmissionLease
    const native = FileLock.tryAcquire(key)
    if (!native.acquired) {
      closePins(pins)
      return {
        status: 'occupied',
        diagnostics: [{ code: 'lease-occupied', message: 'Destination mutex is occupied', errno: null }],
      }
    }
    entry = { handle, native, creator: process.pid, pins, released: false, usable: true }
    held.set(handle, entry)
    check(entry)
    return { status: 'acquired', lease: handle }
  } catch (error) {
    if (entry) {
      entry.usable = false
      return { status: 'uncertain', retained: entry.handle, diagnostics: [diagnostic(error)] }
    }
    closePins(pins)
    return { status: 'refused', diagnostics: [diagnostic(error)] }
  }
}
export async function recheckDestinationAdmissionLease(
  lease: DestinationAdmissionLease,
): Promise<
  | { status: 'held'; descriptor: AdmissionDescriptor }
  | { status: 'refused'; diagnostics: readonly AdmissionLeaseFailure[] }
> {
  try {
    const entry = lookup(lease)
    check(entry)
    return { status: 'held', descriptor: lease.descriptor }
  } catch (error) {
    return { status: 'refused', diagnostics: [diagnostic(error)] }
  }
}
export async function releaseDestinationAdmissionLease(
  lease: DestinationAdmissionLease,
): Promise<{ status: 'released' } | { status: 'refused'; diagnostics: readonly AdmissionLeaseFailure[] }> {
  try {
    if (completed.has(lease)) return { status: 'released' }
    const entry = lookup(lease)
    // The OS-account sidecar is persistent: never unlink, truncate, or replace it.
    if (entry.handle.descriptor.namespace.kind === 'darwin-file') checkPins(entry.pins)
    entry.native.release()
    entry.released = true
    held.delete(lease)
    completed.add(lease)
    closePins(entry.pins)
    return { status: 'released' }
  } catch (error) {
    return { status: 'refused', diagnostics: [diagnostic(error)] }
  }
}
