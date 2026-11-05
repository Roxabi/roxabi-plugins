// TEMPORARY #905: remove with the trace collector.
export type Cpu = { user: number; system: number }
type Point = { mono: number; wall: number; realtime: number; cpu: Cpu }
export type Call = {
  pid: number
  ppid: number
  processOrigin: number
  times: Record<string, number>
  committed: boolean
  bytes: number
  cpu: Cpu
  persistPhase?: string
  serializedCharacters?: number
  boundaries?: Record<string, Point>
}
export type Interval = { start: number; end: number; pid: number; id: number; cpu?: Cpu; phase: string }
export const definitions = [
  ['serialize', 'p0', 'p1'],
  ['write', 'p1', 'p2'],
  ['rename', 'p2', 'p3'],
] as const
export function union(intervals: Interval[], from = -Infinity, to = Infinity): number {
  let end = from
  let total = 0
  for (const item of intervals.slice().sort((a, b) => a.start - b.start)) {
    const left = Math.max(from, item.start, end)
    const right = Math.min(to, item.end)
    if (right > left) total += right - left
    end = Math.max(end, right)
  }
  return total
}
function phaseInterval(a: Point, b: Point, call: Call, id: number, phase: string): Interval | undefined {
  const mono = b.mono - a.mono
  const wall = b.wall - a.wall
  const user = b.cpu.user - a.cpu.user
  const system = b.cpu.system - a.cpu.system
  if (
    !Number.isFinite(mono) ||
    !Number.isFinite(wall) ||
    !Number.isFinite(a.realtime) ||
    !Number.isFinite(b.realtime) ||
    !Number.isFinite(user) ||
    !Number.isFinite(system) ||
    mono < 0 ||
    wall < 0 ||
    Math.abs(mono - wall) > 1 ||
    Math.abs(a.realtime - a.wall) > 20 ||
    Math.abs(b.realtime - b.wall) > 20 ||
    Math.abs(b.realtime - a.realtime - mono) > 20 ||
    user < 0 ||
    system < 0
  )
    return undefined
  return { start: a.wall, end: b.wall, pid: call.pid, id, phase, cpu: { user, system } }
}
function collectEnvelopes(call: Call, id: number, intervals: Record<string, Interval[]>) {
  if (Number.isFinite(call.times.start) && Number.isFinite(call.times.unlock) && call.times.unlock >= call.times.start)
    intervals.transaction?.push({
      start: call.times.start,
      end: call.times.unlock,
      pid: call.pid,
      id,
      phase: 'transaction',
    })
  if (
    Number.isFinite(call.times.handle) &&
    Number.isFinite(call.times.persist) &&
    call.times.persist >= call.times.handle
  )
    intervals.persistEnvelope?.push({
      start: call.times.handle,
      end: call.times.persist,
      pid: call.pid,
      id,
      phase: 'persistEnvelope',
    })
}
function collectOne(call: Call, id: number, intervals: Record<string, Interval[]>) {
  collectEnvelopes(call, id, intervals)
  const points = call.boundaries
  const attempted = call.persistPhase !== undefined || call.committed
  const incomplete = attempted && (!points?.p0 || !points.p1 || !points.p2 || !points.p3)
  let invalid = false
  for (const [phase, first, last] of definitions) {
    const a = points?.[first]
    const b = points?.[last]
    if (!a || !b) continue
    const interval = phaseInterval(a, b, call, id, phase)
    if (interval) intervals[phase]?.push(interval)
    else invalid = true
  }
  if (points?.p0 && points.p3 && !invalid && points.p3.wall >= points.p0.wall)
    intervals.persist?.push({
      start: points.p0.wall,
      end: points.p3.wall,
      pid: call.pid,
      id,
      phase: 'persist',
      cpu: { user: points.p3.cpu.user - points.p0.cpu.user, system: points.p3.cpu.system - points.p0.cpu.system },
    })
  return { incomplete, invalid, attempted, failedAttempt: attempted && call.persistPhase !== 'complete' }
}
export function collect905Intervals(calls: Call[]) {
  const intervals: Record<string, Interval[]> = {
    transaction: [],
    persistEnvelope: [],
    persist: [],
    serialize: [],
    write: [],
    rename: [],
  }
  let invalidClocks = 0
  let incompleteBoundaries = 0
  let notAttempted = 0
  let attempted = 0
  let failedAttempts = 0
  for (const [id, call] of calls.entries()) {
    const result = collectOne(call, id, intervals)
    if (result.incomplete) incompleteBoundaries++
    if (result.invalid) invalidClocks++
    if (result.attempted) attempted++
    else notAttempted++
    if (result.failedAttempt) failedAttempts++
  }
  return {
    intervals,
    incompleteBoundaries,
    invalidClocks,
    attempted,
    notAttempted,
    failedAttempts,
    complete: attempted > 0 && incompleteBoundaries === 0 && invalidClocks === 0,
  }
}
