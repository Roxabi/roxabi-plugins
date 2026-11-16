import * as fs from 'node:fs'
import { type ProcessLifetime, processLifetimeSchema } from '../../engine/fix-recovery-schema.ts'

export type LeaseFailure = {
  code:
    | 'unsupported-host'
    | 'namespace-unobservable'
    | 'namespace-mismatch'
    | 'unsafe-path'
    | 'unsafe-permissions'
    | 'invalid-destination'
    | 'lease-occupied'
    | 'lease-replaced'
    | 'lease-metadata-mismatch'
    | 'lease-handle-invalid'
    | 'lease-io-unknown'
    | 'process-unobservable'
    | 'process-identity-race'
    | 'process-parse-invalid'
  message: string
  errno: string | null
}
class Failure extends Error {
  constructor(
    readonly code: LeaseFailure['code'],
    message: string,
    readonly errno: string | null = null,
  ) {
    super(message)
  }
}
export function failure(error: unknown, fallback: LeaseFailure['code'] = 'lease-io-unknown'): LeaseFailure {
  if (error instanceof Failure) return { code: error.code, message: error.message, errno: error.errno }
  const e = error as NodeJS.ErrnoException
  return { code: fallback, message: e?.message ?? String(error), errno: e?.code ?? null }
}
export function reject(code: LeaseFailure['code'], message: string): never {
  throw new Failure(code, message)
}
export function required<T>(value: T | undefined): T {
  if (value === undefined) reject('namespace-unobservable', 'Required host observation is missing')
  return value
}
export function parseStat(text: string, expected: number): string {
  const match = /^(\d+) \([\s\S]*\) ([A-Za-z]) (.*)\s*$/.exec(text)
  if (!match || Number(match[1]) !== expected) reject('process-parse-invalid', 'Invalid proc stat PID or comm')
  const fields = required(match[3]).trim().split(/\s+/)
  const ticks = fields[18]
  if (!ticks || !/^\d+$/.test(ticks)) reject('process-parse-invalid', 'Invalid proc stat start ticks')
  return ticks
}
function procView(): void {
  if (process.platform !== 'linux' || typeof process.geteuid !== 'function')
    reject('unsupported-host', 'Linux effective UID is required')
  const mapping = fs.readFileSync('/proc/self/uid_map', 'utf8').trim()
  if (!/^0\s+0\s+4294967295$/.test(mapping))
    reject('namespace-unobservable', 'UID mapping is not the full identity mapping')
  if (Number(fs.statfsSync('/proc', { bigint: true }).type) !== 0x9fa0)
    reject('process-unobservable', '/proc is not procfs')
  const lines = fs.readFileSync('/proc/self/mountinfo', 'utf8').trim().split('\n')
  const mounts = lines
    .map((line) => {
      const [left, right] = line.split(' - ')
      return { left: left?.split(' ') ?? [], right: right?.split(' ') ?? [] }
    })
    .filter((m) => m.left[4] === '/proc')
  const mount = mounts[0]
  if (
    mounts.length !== 1 ||
    !mount ||
    mount.left[3] !== '/' ||
    mount.right[0] !== 'proc' ||
    /(?:^|,)(?:hidepid=(?!0(?:,|$))[^,]*|subset=pid)(?:,|$)/.test(`${mount.left[5]},${mount.right[2]}`)
  )
    reject('process-unobservable', 'Procfs mount root or visibility is unsupported')
  if (fs.readlinkSync('/proc/self') !== String(process.pid))
    reject('process-unobservable', 'Procfs self PID does not match this process')
  parseStat(fs.readFileSync('/proc/self/stat', 'utf8'), process.pid)
}
function ns(name: string): string {
  const value = fs.readlinkSync(`/proc/self/ns/${name}`)
  if (!new RegExp(`^${name === 'mnt' ? 'mnt' : name}:\\[\\d+\\]$`).test(value))
    reject('namespace-unobservable', `Invalid ${name} namespace identity`)
  return value
}
export function self(): { process: ProcessLifetime; mount: string; network: string } {
  procView()
  const effectiveUid = required(process.geteuid)()
  const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(bootId))
    reject('namespace-unobservable', 'Invalid boot identity')
  const userNamespace = ns('user'),
    pidNamespace = ns('pid'),
    mount = ns('mnt'),
    network = ns('net')
  const processStartTicks = parseStat(fs.readFileSync('/proc/self/stat', 'utf8'), process.pid)
  return {
    process: processLifetimeSchema.parse({
      bootId,
      userNamespace,
      pidNamespace,
      effectiveUid,
      pid: process.pid,
      processStartTicks,
    }),
    mount,
    network,
  }
}
