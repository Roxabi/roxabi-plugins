// TEMPORARY #905: remove this diagnostic with the hosted observation.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type Call,
  type Cpu,
  collect905Intervals,
  definitions,
  type Interval,
  union,
} from './feature-review-905-intervals.ts'

const root = process.argv[2]
if (!root) throw new Error('trace directory required')
function summarize(dir: string, goal: boolean) {
  type Stage = { name: string; at: number; pid: number; cpu: Cpu; resources?: unknown }
  function records<T>(name: string): T[] {
    const file = join(dir, name)
    if (!existsSync(file)) return []
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T)
  }
  const stages = records<Stage>('stages.jsonl')
  const calls = records<Call>('simulator.jsonl')
  const start = stages.find((stage) => stage.name === 'test-start')
  const deadline = start === undefined ? undefined : start.at + 30_000
  const runner = goal ? start?.pid : stages.find((stage) => stage.name === 'initial-review')?.pid
  const cuts = stages.filter((stage) => stage.pid === runner).sort((a, b) => a.at - b.at)
  const { intervals, incompleteBoundaries, invalidClocks, complete, attempted, notAttempted, failedAttempts } =
    collect905Intervals(calls)
  function report(items: Interval[], from = -Infinity, to = Infinity) {
    const overlapping = items.filter((item) => item.start < to && item.end > from)
    const contained = overlapping.filter((item) => item.start >= from && item.end <= to)
    return {
      unionMs: overlapping.length ? union(overlapping, from, to) : null,
      wallSumMs: overlapping.length
        ? overlapping.reduce((sum, item) => sum + Math.max(0, Math.min(to, item.end) - Math.max(from, item.start)), 0)
        : null,
      coverage: complete ? 'complete-observed-attempts' : 'partial-or-unavailable',
      observedIntervals: overlapping.length,
      crossingIntervals: overlapping.length - contained.length,
      containedCpuMicros:
        contained.every((item) => item.cpu !== undefined) && contained.length > 0
          ? {
              user: contained.reduce((sum, item) => sum + (item.cpu?.user ?? 0), 0),
              system: contained.reduce((sum, item) => sum + (item.cpu?.system ?? 0), 0),
            }
          : null,
    }
  }
  type Counters = { available: boolean; value?: Record<string, number> }
  type GroupSnapshot = {
    scope: string
    cpuPressure: Counters
    ioPressure: Counters
    ancestors: Array<{ cpu: Counters; local: Counters }>
  }
  type Resources = { groups?: GroupSnapshot[]; host?: { cpu: Counters; io: Counters } }
  function delta(a: Counters | undefined, b: Counters | undefined) {
    if (!a?.available || !b?.available || !a.value || !b.value) return null
    return Object.fromEntries(
      Object.entries(b.value).flatMap(([key, value]) => {
        const prior = a.value?.[key]
        return prior !== undefined && Number.isSafeInteger(prior) && Number.isSafeInteger(value) && value >= prior
          ? [[key, value - prior]]
          : []
      }),
    )
  }
  function pressureDeltas(a: Stage, b: Stage) {
    if (a.pid !== b.pid) return null
    const first = a.resources as Resources | undefined
    const last = b.resources as Resources | undefined
    const groups =
      Array.isArray(first?.groups) && Array.isArray(last?.groups)
        ? last.groups.map((group) => {
            const previous = first?.groups?.find((entry) => entry.scope === group.scope)
            return {
              scope: group.scope,
              cpuPressure: delta(previous?.cpuPressure, group.cpuPressure),
              ioPressure: delta(previous?.ioPressure, group.ioPressure),
              ancestors: group.ancestors.map((ancestor, index) => ({
                cpu: delta(previous?.ancestors[index]?.cpu, ancestor.cpu),
                local: delta(previous?.ancestors[index]?.local, ancestor.local),
              })),
            }
          })
        : null
    return {
      host: { cpu: delta(first?.host?.cpu, last?.host?.cpu), io: delta(first?.host?.io, last?.host?.io) },
      groups,
    }
  }
  const phases = Object.fromEntries(Object.entries(intervals).map(([name, items]) => [name, report(items)]))
  const stageIntervals = cuts.slice(0, -1).map((stage, index) => {
    const next = cuts[index + 1]
    if (!next) throw new Error('stage-cut-missing')
    return {
      name: stage.name,
      from: stage.at,
      to: next.at,
      pressureDeltas: pressureDeltas(stage, next),
      phases: Object.fromEntries(
        Object.entries(intervals).map(([name, items]) => [name, report(items, stage.at, next.at)]),
      ),
    }
  })
  const tails = (intervals.persist ?? [])
    .filter((item) => item.end - item.start > 100)
    .map((item) => {
      const parts = definitions.map(([name]) => (intervals[name] ?? []).find((part) => part.id === item.id))
      return {
        pid: item.pid,
        start: item.start,
        durationMs: item.end - item.start,
        phases: parts.map((part) =>
          part ? { name: part.phase, durationMs: part.end - part.start, cpu: part.cpu } : null,
        ),
        owner: parts.filter((part) => part !== undefined).sort((a, b) => b.end - b.start - (a.end - a.start))[0]?.phase,
      }
    })
  type Envelope = {
    id: number
    event: string
    kind: string
    operation?: string
    outcome?: string
    pid: number
    processOrigin: number
    wall: number
    mono: number
    cpu: Cpu
  }
  function envelopeSummary() {
    const events = records<Envelope>('envelopes.jsonl')
    const starts = events.filter((event) => event.event === 'start')
    const envelopes = starts.map((first) => {
      const last = events.find(
        (event) =>
          event.event === 'finish' &&
          event.id === first.id &&
          event.pid === first.pid &&
          event.processOrigin === first.processOrigin,
      )
      return {
        id: first.id,
        kind: first.kind,
        operation: first.operation,
        start: first.wall,
        end: last?.wall,
        outcome: last?.outcome,
        parentCpu: last ? { user: last.cpu.user - first.cpu.user, system: last.cpu.system - first.cpu.system } : null,
        childPid: null,
      }
    })
    const envelopeIntervals: Interval[] = envelopes.flatMap((event) =>
      event.end === undefined || event.end < event.start
        ? []
        : [{ start: event.start, end: event.end, pid: start?.pid ?? 0, id: event.id, phase: event.kind }],
    )
    const finish = stages.find((stage) => stage.name === 'test-finish')
    const observedEnvelopeUnion = union(envelopeIntervals)
    const observedTestWall = start && finish ? finish.at - start.at : null
    function parentGaps() {
      const gaps: Array<{ start: number; end: number }> = []
      if (!goal || !start || !finish) return gaps
      let cursor = start.at
      for (const item of envelopeIntervals.slice().sort((a, b) => a.start - b.start)) {
        const begin = Math.max(start.at, item.start)
        if (begin > cursor) gaps.push({ start: cursor, end: begin })
        cursor = Math.max(cursor, Math.min(finish.at, item.end))
      }
      if (cursor < finish.at) gaps.push({ start: cursor, end: finish.at })
      return gaps
    }
    return {
      envelopes,
      observedEnvelopeUnionMs: goal ? observedEnvelopeUnion : null,
      observedTestOutsideEnvelopeUnionMs:
        goal && observedTestWall !== null ? observedTestWall - observedEnvelopeUnion : null,
      observedParentGaps: goal ? parentGaps() : null,
      deadlineEnvelopes:
        goal && deadline !== undefined
          ? envelopes.filter((event) => event.start <= deadline && (event.end === undefined || event.end >= deadline))
          : null,
      envelopeCompleteness: goal
        ? {
            starts: starts.length,
            finishes: events.filter((event) => event.event === 'finish').length,
            unmatched: envelopes.filter((event) => event.end === undefined).length,
          }
        : null,
    }
  }
  const summary = {
    diagnostic: calls.length && stages.length ? 'partial-observation' : 'diagnostic-unavailable',
    stages,
    deadline,
    activeAtApproximateDeadline:
      deadline === undefined
        ? undefined
        : stages
            .filter((stage) => stage.at <= deadline)
            .sort((a, b) => a.at - b.at)
            .at(-1)?.name,
    case: goal ? 'goal' : 'mixed',
    goalTraceDirectoryPresent: existsSync(join(root, 'goal')),
    distinctObservedProcesses: new Set(calls.map((call) => `${call.pid}:${call.processOrigin}`)).size,
    ...envelopeSummary(),
    simulatorTransactionsObserved: calls.length,
    committedObserved: calls.filter((call) => call.committed).length,
    inputBytesObserved: calls.reduce((sum, call) => sum + call.bytes, 0),
    transactionCpuMicros: {
      user: calls.reduce((sum, call) => sum + call.cpu.user, 0),
      system: calls.reduce((sum, call) => sum + call.cpu.system, 0),
    },
    completeness: {
      complete,
      incompleteBoundaries,
      invalidClocks,
      attempted,
      notAttempted,
      failedAttempts,
      note: 'Only observed events can be assessed; killed children and failed append are not observable.',
    },
    phases,
    stageIntervals,
    beforeDeadline:
      deadline === undefined || start === undefined
        ? null
        : Object.fromEntries(
            Object.entries(intervals).map(([name, items]) => [name, report(items, start.at, deadline)]),
          ),
    tailsOver100ms: tails,
    profilePresent: existsSync(join(dir, 'runtime.cpuprofile')),
    limitations:
      'CPU is process-wide, not exclusive JS-thread time. Wall minus CPU is not I/O. Interval unions are observed transactions, not complete child critical path. Startup, Git, other descendants and trace append are absent. Mixed does not explain the separate goal timeout.',
  }
  const output = `${JSON.stringify(summary, null, 2)}\n`
  writeFileSync(join(dir, 'summary.json'), output)
  process.stdout.write(output)
}
summarize(root, false)
if (existsSync(join(root, 'goal'))) summarize(join(root, 'goal'), true)
