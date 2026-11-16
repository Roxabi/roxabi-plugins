import * as fs from 'node:fs'
import { canonicalValueDigest } from '../../engine/canonical-value.ts'
import {
  type LatchNamespace,
  latchNamespaceSchema,
  type ProcessLifetime,
  processLifetimeSchema,
} from '../../engine/fix-recovery-schema.ts'
import { failure, type LeaseFailure, parseStat, reject, required, self } from './linux-process-identity.ts'

export type { LeaseFailure } from './linux-process-identity.ts'

function same(a: unknown, b: unknown): boolean {
  return canonicalValueDigest(a) === canonicalValueDigest(b)
}
const C = fs.constants
const dirFlags = C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW
function child(fd: number, name: string): string {
  return `/proc/self/fd/${fd}/${name}`
}
function identity(a: fs.BigIntStats, b: fs.BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino
}
function closeAll(fds: number[]): void {
  for (const fd of fds.reverse()) {
    try {
      fs.closeSync(fd)
    } catch {
      /* preserve original failure */
    }
  }
}
function safeDir(stat: fs.BigIntStats, uid: number, privateDir: boolean): void {
  if (!stat.isDirectory()) reject('unsafe-path', 'Expected a directory')
  if (stat.uid !== BigInt(uid) || (privateDir ? (stat.mode & 0o7777n) !== 0o700n : (stat.mode & 0o022n) !== 0n))
    reject('unsafe-permissions', 'Unsafe directory ownership or mode')
}
function openDir(path: string, uid: number, privateDir: boolean): number {
  const before = fs.lstatSync(path, { bigint: true })
  safeDir(before, uid, privateDir)
  const fd = fs.openSync(path, dirFlags)
  try {
    const after = fs.fstatSync(fd, { bigint: true })
    safeDir(after, uid, privateDir)
    if (!identity(before, after) || !identity(after, fs.lstatSync(path, { bigint: true })))
      reject('unsafe-path', 'Directory changed while opening')
    return fd
  } catch (e) {
    fs.closeSync(fd)
    throw e
  }
}
function openTree(uid: number, create: boolean): number[] {
  const dirs: number[] = []
  try {
    dirs.push(openDir('/', 0, false))
    dirs.push(openDir(child(required(dirs[0]), 'run'), 0, false))
    dirs.push(openDir(child(required(dirs[1]), 'user'), 0, false))
    dirs.push(openDir(child(required(dirs[2]), String(uid)), uid, true))
    if (Number(fs.statfsSync(child(required(dirs[2]), String(uid)), { bigint: true }).type) !== 0x01021994)
      reject('unsafe-path', 'Runtime root is not local tmpfs')
    for (const name of ['omp-build-execution', 'v1']) {
      const path = child(required(dirs[dirs.length - 1]), name)
      if (create) {
        try {
          fs.mkdirSync(path, { mode: 0o700 })
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
        }
      }
      dirs.push(openDir(path, uid, true))
    }
    return dirs
  } catch (e) {
    closeAll(dirs)
    throw e
  }
}
type HostObservation = { process: ProcessLifetime; namespace: LatchNamespace }
function measure(dirs: number[]): HostObservation {
  const first = self(),
    uid = first.process.effectiveUid
  const paths = [
    '/',
    '/run',
    '/run/user',
    `/run/user/${uid}`,
    `/run/user/${uid}/omp-build-execution`,
    `/run/user/${uid}/omp-build-execution/v1`,
  ]
  for (let i = 0; i < dirs.length; i++) {
    const currentPath = required(paths[i])
    const stat = fs.fstatSync(required(dirs[i]), { bigint: true })
    safeDir(stat, i < 3 ? 0 : uid, i >= 3)
    const absolute = fs.lstatSync(currentPath, { bigint: true })
    safeDir(absolute, i < 3 ? 0 : uid, i >= 3)
    if (!identity(stat, absolute)) reject('unsafe-path', 'Runtime directory path changed')
    if (
      i &&
      !identity(
        stat,
        fs.lstatSync(child(required(dirs[i - 1]), required(currentPath.split('/').pop())), { bigint: true }),
      )
    )
      reject('unsafe-path', 'Runtime directory ancestry changed')
  }
  if (Number(fs.statfsSync(required(paths[3]), { bigint: true }).type) !== 0x01021994)
    reject('unsafe-path', 'Runtime filesystem changed')
  const root = fs.fstatSync(required(dirs[3]), { bigint: true }),
    latch = fs.fstatSync(required(dirs[5]), { bigint: true })
  const namespace = latchNamespaceSchema.parse({
    protocol: 'omp-build-execution/v1',
    bootId: first.process.bootId,
    effectiveUid: uid,
    userNamespace: first.process.userNamespace,
    pidNamespace: first.process.pidNamespace,
    mountNamespace: first.mount,
    networkNamespace: first.network,
    canonicalHostRoot: paths[3],
    rootDevice: String(root.dev),
    rootInode: String(root.ino),
    latchRootDevice: String(latch.dev),
    latchRootInode: String(latch.ino),
  })
  if (!same(first, self())) reject('namespace-unobservable', 'Host identity changed during measurement')
  return { process: first.process, namespace }
}
/** Optional strict recovery qualification. Failure does not replace the common admission mutex. */
export async function observeCurrentLinuxHost(): Promise<
  | { status: 'qualified'; process: ProcessLifetime; namespace: LatchNamespace }
  | { status: 'unavailable'; diagnostics: readonly LeaseFailure[] }
> {
  let dirs: number[] = []
  try {
    const current = self()
    dirs = openTree(current.process.effectiveUid, true)
    const observed = measure(dirs)
    if (!same(current.process, observed.process))
      reject('namespace-unobservable', 'Process changed during qualification')
    return { status: 'qualified', ...observed }
  } catch (error) {
    return { status: 'unavailable', diagnostics: [failure(error, 'process-unobservable')] }
  } finally {
    closeAll(dirs)
  }
}

function openPriorProcess(proc: string, dirs: number[], before: HostObservation): number | undefined {
  try {
    return fs.openSync(proc, dirFlags)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    if (!same(before, measure(dirs))) reject('process-identity-race', 'Host changed during absence observation')
    try {
      fs.lstatSync(proc)
      reject('process-identity-race', 'PID appeared during absence observation')
    } catch (again) {
      if ((again as NodeJS.ErrnoException).code !== 'ENOENT') throw again
    }
    return undefined
  }
}

function inspectPriorProcess(
  procFd: number,
  proc: string,
  prior: ProcessLifetime,
  namespace: LatchNamespace,
  dirs: number[],
  before: HostObservation,
): ProcessLifetime {
  const first = parseStat(fs.readFileSync(child(procFd, 'stat'), 'utf8'), prior.pid)
  const status = fs.readFileSync(child(procFd, 'status'), 'utf8')
  const uid = /^Uid:\s+\d+\s+(\d+)\s+\d+\s+\d+\s*$/m.exec(status)
  if (!uid || !Number.isSafeInteger(Number(uid[1]))) reject('process-parse-invalid', 'Invalid proc effective UID')
  const userNamespace = fs.readlinkSync(child(procFd, 'ns/user')),
    pidNamespace = fs.readlinkSync(child(procFd, 'ns/pid')),
    networkNamespace = fs.readlinkSync(child(procFd, 'ns/net'))
  const second = parseStat(fs.readFileSync(child(procFd, 'stat'), 'utf8'), prior.pid)
  if (
    first !== second ||
    !identity(fs.fstatSync(procFd, { bigint: true }), fs.statSync(proc, { bigint: true })) ||
    !same(before, measure(dirs))
  )
    reject('process-identity-race', 'Process or host changed during observation')
  if (
    Number(uid[1]) !== namespace.effectiveUid ||
    userNamespace !== namespace.userNamespace ||
    pidNamespace !== namespace.pidNamespace ||
    networkNamespace !== namespace.networkNamespace
  )
    reject('process-unobservable', 'Observed process UID or namespace is incompatible')
  return processLifetimeSchema.parse({
    bootId: namespace.bootId,
    userNamespace,
    pidNamespace,
    effectiveUid: Number(uid[1]),
    pid: prior.pid,
    processStartTicks: first,
  })
}

export async function observePriorLinuxProcess(
  input: Readonly<{ process: ProcessLifetime; namespace: LatchNamespace }>,
): Promise<
  | { state: 'alive'; observed: ProcessLifetime }
  | { state: 'positively-ended'; basis: 'pid-reused'; observed: ProcessLifetime }
  | { state: 'positively-ended'; basis: 'absent-in-validated-procfs' }
  | { state: 'unknown'; diagnostics: readonly LeaseFailure[] }
> {
  let dirs: number[] = [],
    procFd: number | undefined
  try {
    const prior = processLifetimeSchema.parse(input.process),
      namespace = latchNamespaceSchema.parse(input.namespace)
    const current = self()
    dirs = openTree(current.process.effectiveUid, false)
    const before = measure(dirs)
    if (
      !same(namespace, before.namespace) ||
      prior.bootId !== namespace.bootId ||
      prior.effectiveUid !== namespace.effectiveUid ||
      prior.userNamespace !== namespace.userNamespace ||
      prior.pidNamespace !== namespace.pidNamespace
    )
      reject('namespace-mismatch', 'Prior process namespace is incompatible')
    const proc = `/proc/${prior.pid}`
    procFd = openPriorProcess(proc, dirs, before)
    if (procFd === undefined) return { state: 'positively-ended', basis: 'absent-in-validated-procfs' }
    const observed = inspectPriorProcess(procFd, proc, prior, namespace, dirs, before)
    return observed.processStartTicks === prior.processStartTicks
      ? { state: 'alive', observed }
      : { state: 'positively-ended', basis: 'pid-reused', observed }
  } catch (e) {
    return { state: 'unknown', diagnostics: [failure(e, 'process-unobservable')] }
  } finally {
    if (procFd !== undefined) {
      try {
        fs.closeSync(procFd)
      } catch {}
    }
    closeAll(dirs)
  }
}
