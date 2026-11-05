// TEMPORARY #905: bounded, read-only context; remove after the hosted observation.

import { createHash } from 'node:crypto'
import { closeSync, openSync, readSync, statfsSync, statSync } from 'node:fs'
import path from 'node:path'

type Result<T> = { available: true; value: T } | { available: false; reason: string }
const unavailable = (reason: string): Result<never> => ({ available: false, reason })
function readBounded(file: string): Result<string> {
  let fd: number | undefined
  try {
    fd = openSync(file, 'r')
    const buffer = Buffer.alloc(65537)
    let count = 0
    for (;;) {
      const size = readSync(fd, buffer, count, buffer.length - count, null)
      if (size === 0) break
      count += size
      if (count === buffer.length) break
    }
    if (count === buffer.length) return unavailable('oversized')
    return { available: true, value: buffer.subarray(0, count).toString('utf8') }
  } catch (error) {
    return unavailable((error as NodeJS.ErrnoException).code ?? 'read-error')
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}
function numericFile(file: string, keys: string[]): Result<Record<string, number>> {
  const result = readBounded(file)
  if (!result.available) return result
  const values: Record<string, number> = {}
  for (const line of result.value.split('\n')) {
    const [key, raw] = line.trim().split(/\s+/)
    if (key && keys.includes(key) && raw && /^\d+$/.test(raw)) {
      const value = Number(raw)
      if (!Number.isSafeInteger(value)) return unavailable('unsafe-integer')
      values[key] = value
    }
  }
  return Object.keys(values).length ? { available: true, value: values } : unavailable('unsupported')
}
function pressure(file: string, omitFull = false): Result<Record<string, number>> {
  const result = readBounded(file)
  if (!result.available) return result
  const values: Record<string, number> = {}
  for (const line of result.value.split('\n')) {
    const match = /^(some|full)\s+.*\btotal=(\d+)/.exec(line)
    if (match?.[1] && match[2] && !(omitFull && match[1] === 'full')) {
      const value = Number(match[2])
      if (!Number.isSafeInteger(value)) return unavailable('unsafe-integer')
      values[match[1]] = value
    }
  }
  return Object.keys(values).length ? { available: true, value: values } : unavailable('unsupported')
}
function ioFields(fields: string[]): Result<Record<string, number>> {
  const values: Record<string, number> = {}
  for (const field of fields) {
    const match = /^(rbytes|wbytes|rios|wios|dbytes|dios)=(\d+)$/.exec(field)
    if (!match?.[1] || !match[2]) continue
    const value = Number(match[2])
    if (!Number.isSafeInteger(value)) return unavailable('unsafe-integer')
    values[match[1]] = value
  }
  return { available: true, value: values }
}
function ioStats(file: string): Result<Record<string, Record<string, number>>> {
  const result = readBounded(file)
  if (!result.available) return result
  const devices: Record<string, Record<string, number>> = {}
  for (const line of result.value.split('\n')) {
    const [device, ...fields] = line.trim().split(/\s+/)
    if (!device || !/^\d+:\d+$/.test(device)) continue
    const values = ioFields(fields)
    if (!values.available) return values
    devices[device] = values.value
  }
  return Object.keys(devices).length ? { available: true, value: devices } : unavailable('unsupported')
}
const unescapeMount = (s: string) =>
  s.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)))
type Group = { directory: string; root: string; version: number; scope: string }
function mountVersion(details: string[], controllers: string[], unified: boolean): number {
  if (details[0] === 'cgroup2') return unified ? 2 : 0
  if (details[0] !== 'cgroup') return 0
  if (!controllers.includes('cpu') || !details[2]?.split(',').includes('cpu')) return 0
  return 1
}
function memberRelative(root: string, mount: string, member: string): string | undefined {
  if (!root || !mount) return undefined
  if (member !== root && !member.startsWith(`${root === '/' ? '' : root}/`)) return undefined
  return root === '/' ? member.slice(1) : member.slice(root.length).replace(/^\//, '')
}
function mountedGroup(row: string, member: string, controllers: string[], unified: boolean): Group | undefined {
  const [before, after] = row.split(' - ')
  const fields = before?.split(' ') ?? []
  const details = after?.split(' ') ?? []
  const version = mountVersion(details, controllers, unified)
  if (!version) return undefined
  const root = unescapeMount(fields[3] ?? '')
  const mount = unescapeMount(fields[4] ?? '')
  const relative = memberRelative(root, mount, member)
  if (relative === undefined) return undefined
  const directory = path.resolve(mount, relative)
  if (directory !== mount && !directory.startsWith(`${mount}/`)) return undefined
  return {
    directory,
    root: mount,
    version,
    scope: createHash('sha256').update(`${version}:${fields[2]}:${directory}`).digest('hex').slice(0, 16),
  }
}
function membershipGroups(line: string, mounts: string): Group[] {
  const match = /^(\d+):([^:]*):(\/.*)$/.exec(line)
  if (!match) return []
  const controllers = match[2]?.split(',') ?? []
  const member = match[3] ?? ''
  const unified = match[1] === '0' && match[2] === ''
  return mounts.split('\n').flatMap((row) => {
    const group = mountedGroup(row, member, controllers, unified)
    return group ? [group] : []
  })
}
function discover(): Result<{ groups: Group[]; truncated: boolean; discovered: number }> {
  const membership = readBounded('/proc/self/cgroup')
  const mounts = readBounded('/proc/self/mountinfo')
  if (!membership.available) return membership
  if (!mounts.available) return mounts
  const groups = membership.value.split('\n').flatMap((line) => membershipGroups(line, mounts.value))
  return groups.length
    ? {
        available: true,
        value: { groups: groups.slice(0, 4), truncated: groups.length > 4, discovered: groups.length },
      }
    : unavailable('no-visible-cgroup')
}
function filesystem(file: string | undefined) {
  if (!file) return unavailable('unset')
  try {
    const stat = statSync(file)
    const fs = statfsSync(file)
    if (!Number.isSafeInteger(stat.dev) || !Number.isSafeInteger(fs.type)) return unavailable('unsafe-integer')
    return { available: true as const, value: { device: stat.dev, type: fs.type } }
  } catch (error) {
    return unavailable((error as NodeJS.ErrnoException).code ?? 'stat-error')
  }
}
function cpuSet(file: string): Result<number> {
  const result = readBounded(file)
  if (!result.available) return result
  const ranges = result.value.trim().split(',')
  let count = 0
  for (const range of ranges) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(range)
    if (!match?.[1]) return unavailable('unsupported')
    const first = Number(match[1])
    const last = match[2] === undefined ? first : Number(match[2])
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || last < first || last > 1048575)
      return unavailable('unsupported')
    count += last - first + 1
    if (!Number.isSafeInteger(count)) return unavailable('unsafe-integer')
  }
  return { available: true, value: count }
}
function groupAncestors(group: Group) {
  const ancestors = []
  let directory = group.directory
  let reachedVisibleRoot = false
  for (let depth = 0; depth < 4; depth++) {
    ancestors.push({
      depth,
      cpu: numericFile(path.join(directory, 'cpu.stat'), [
        'usage_usec',
        'user_usec',
        'system_usec',
        'nr_periods',
        'nr_throttled',
        'throttled_usec',
        'nr_bursts',
        'burst_usec',
        'nr_periods',
        'nr_throttled',
        'throttled_time',
      ]),
      local: numericFile(path.join(directory, 'cpu.stat.local'), ['throttled_usec']),
    })
    if (directory === group.root) {
      reachedVisibleRoot = true
      break
    }
    const parent = path.dirname(directory)
    if (parent === directory || !parent.startsWith(group.root)) break
    directory = parent
  }
  return { ancestors, reachedVisibleRoot }
}
function groupLimit(group: Group, initialized: boolean) {
  const max = initialized ? readBounded(path.join(group.directory, 'cpu.max')) : unavailable('not-collected')
  if (!max.available) return unavailable(max.reason)
  const limit = /^(max|\d+)\s+(\d+)/.exec(max.value)
  if (
    !limit ||
    !Number.isSafeInteger(Number(limit[2])) ||
    (limit[1] !== 'max' && !Number.isSafeInteger(Number(limit[1])))
  )
    return unavailable('unsupported-or-unsafe')
  return { available: true, quota: limit[1] === 'max' ? null : Number(limit[1]), period: Number(limit[2]) }
}
function snapshotGroup(group: Group, initialized: boolean) {
  const { ancestors, reachedVisibleRoot } = groupAncestors(group)
  return {
    scope: group.scope,
    version: group.version,
    ancestors,
    ancestorCoverage: reachedVisibleRoot
      ? 'visible-mount-root-only; hidden-ancestors-unknown'
      : 'bounded-or-unavailable',
    cpuPressure: pressure(path.join(group.directory, 'cpu.pressure')),
    ioPressure: pressure(path.join(group.directory, 'io.pressure')),
    io: ioStats(path.join(group.directory, 'io.stat')),
    cpuLimit: groupLimit(group, initialized),
    cpuSetCount: initialized
      ? cpuSet(path.join(group.directory, 'cpuset.cpus.effective'))
      : unavailable('not-collected'),
  }
}
const backingRecorded = new Set<string>()
export function snapshot905Resources(trace: string, initialized: boolean, statePath?: string) {
  const start = performance.now()
  const discovered = discover()
  const groups = discovered.available
    ? discovered.value.groups.map((group) => snapshotGroup(group, initialized))
    : discovered
  let backing: unknown
  if (initialized && !backingRecorded.has(trace)) {
    backingRecorded.add(trace)
    const state = statePath ?? process.env.GH_SIM_STATE
    backing = { state: filesystem(state ? path.dirname(state) : undefined), trace: filesystem(trace) }
  }
  const host = { cpu: pressure('/proc/pressure/cpu', true), io: pressure('/proc/pressure/io') }
  const groupCoverage = discovered.available
    ? { truncated: discovered.value.truncated, discovered: discovered.value.discovered }
    : discovered
  return {
    at: performance.timeOrigin + start,
    durationMs: performance.now() - start,
    groups,
    groupCoverage,
    host,
    backing,
  }
}
