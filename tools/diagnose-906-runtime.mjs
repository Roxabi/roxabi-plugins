import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const directory = process.env.OMP_PHASE_PROBE_DIR
if (!directory) throw new Error('OMP_PHASE_PROBE_DIR is required')
let report
try {
  report = JSON.parse(readFileSync(path.join(directory, 'vitest.json'), 'utf8'))
} catch {
  report = { success: false, testResults: [] }
}
const results = (report.testResults ?? []).flatMap((file) => file.assertionResults ?? [])
const expected = [
  ['apply', 'pushes the owned correction only after native falsification', 60_000],
  ['mixed', 'executes only fix-original while retaining sister-after and report without filing', 60_000],
  ['race', 'does not activate a correction after a complete third canonical request-changes review', 60_000],
  ['goal', 'lands, crashes, merges, stops, and completes without an armed stopped PR', 90_000],
]
const events = []
const counts = new Map()
for (const file of readdirSync(directory).filter((name) => /^probe-\d+\.jsonl$/.test(name))) {
  for (const line of readFileSync(path.join(directory, file), 'utf8').split('\n')) {
    if (!line) continue
    const record = JSON.parse(line)
    if (record.type === 'phase') events.push(record)
    if (record.type === 'counts') for (const row of record.rows) {
      const key = JSON.stringify(row.key)
      const value = counts.get(key) ?? { starts: 0, completed: 0, failed: 0, ns: 0, bytes: 0 }
      for (const field of ['starts', 'completed', 'failed', 'ns', 'bytes']) value[field] += row[field]
      counts.set(key, value)
    }
  }
}
const monotonicDeltaMs = (from, to) => {
  if (!Number.isSafeInteger(from?.pid) || from.pid <= 0 || from.pid !== to?.pid ||
      typeof from.monoNs !== 'string' || !/^\d+$/.test(from.monoNs) ||
      typeof to.monoNs !== 'string' || !/^\d+$/.test(to.monoNs)) return null
  const delta = Number(BigInt(to.monoNs) - BigInt(from.monoNs)) / 1e6
  return Number.isFinite(delta) && delta >= 0 ? delta : null
}
const summary = { diagnostic: 'DO NOT MERGE; not required CI', reportSuccess: report.success, files: report.testResults?.length, tests: results.map((test) => ({ title: test.fullName ?? test.title, status: test.status, durationMs: test.duration })), cases: [], error: [] }
if (report.success !== true || results.length !== 10 || report.testResults?.length !== 3 || results.some((test) => test.status !== 'passed')) summary.error.push('semantic result incomplete or failed')
for (const [name, title, originalMs] of expected) {
  const matches = results.filter((test) => test.title === title)
  const test = matches[0]
  const starts = events.filter((event) => event.phase === `${name}:test-start`)
  const start = starts[0]
  const item = { name, originalMs, testDurationMs: test?.duration, semanticStatus: test?.status, deadlines: {}, phases: [] }
  summary.cases.push(item)
  if (matches.length !== 1 || starts.length !== 1 || !test || test.status !== 'passed' || !Number.isFinite(test.duration) || !start || start.data?.taskTimeoutMs !== 180_000 || !Number.isFinite(start.data?.taskStartMs)) summary.error.push(`${name}: missing or invalid test/clock evidence`)
  if (!start) continue
  if (Number.isFinite(test?.duration)) item.deadlines.test = test.duration < originalMs ? 'within' : 'exceeded'
  const scoped = events.filter((event) => event.scope === start.scope)
  const wallEvents = scoped.filter((event) => Number.isFinite(event.wallMs))
  if (wallEvents.length !== scoped.length) summary.error.push(`${name}: missing or invalid wall-clock display evidence`)
  wallEvents.sort((a, b) => a.wallMs - b.wallMs)
  const wallStart = wallEvents[0]?.wallMs
  item.phaseDisplay = 'wall-clock order and elapsed from first displayed phase; not monotonic causal or CPU evidence'
  item.phases = wallEvents.map((event) => ({ phase: event.phase, pid: event.pid, wallMs: event.wallMs, elapsedWallMs: event.wallMs - wallStart, data: event.data }))
  const one = (phase) => {
    const found = scoped.filter((event) => event.phase === phase)
    return found.length === 1 ? found[0] : null
  }
  if (name === 'apply' || name === 'mixed') {
    const op = name === 'apply' ? 'omp-review-apply-falsify' : 'omp-review-mixed-dispositions'
    const spawn = one(`lifecycle:${op}:child-spawn`)
    const close = one(`lifecycle:${op}:child-close`)
    const arm = one(`lifecycle:${op}:timer-arm`)
    if (!spawn || !arm || !close || spawn.data?.taskTimeoutMs !== 180_000 || !Number.isFinite(arm.data?.originalRemainingMs) || close.data?.status !== 0) summary.error.push(`${name}: missing child budget/close evidence`)
    else {
      const childMs = monotonicDeltaMs(arm, close)
      if (childMs === null) summary.error.push(`${name}: invalid same-process child clock evidence`)
      else {
        item.childMs = childMs
        item.originalChildRemainingMs = arm.data.originalRemainingMs
        item.deadlines.childOriginalRemaining = childMs >= arm.data.originalRemainingMs ? 'exceeded' : childMs >= arm.data.originalRemainingMs - 50 ? 'uncertain' : 'within'
      }
    }
  }
  if (name === 'race') {
    const arm = one('race:marker-arm')
    const marker = one('race:marker-observed')
    const spawn = one('race:child-spawn')
    const close = one('race:child-close')
    if (!arm || !marker || !spawn || !close || close.data?.status !== 0 || arm.data?.diagnosticTimeoutMs !== 60_000 || spawn.data?.diagnosticTimeoutMs !== 120_000) summary.error.push('race: missing marker/child evidence')
    else {
      const markerMs = monotonicDeltaMs(arm, marker)
      const childMs = monotonicDeltaMs(spawn, close)
      if (markerMs === null || childMs === null) summary.error.push('race: invalid same-process marker/child clock evidence')
      else {
        item.markerMs = markerMs
        item.childMs = childMs
        item.deadlines.marker = markerMs >= 10_000 ? 'exceeded' : markerMs >= 9_950 ? 'uncertain' : 'within'
        item.deadlines.child = childMs >= 30_000 ? 'exceeded' : childMs >= 29_950 ? 'uncertain' : 'within'
      }
    }
  }
  if (Object.values(item.deadlines).some((value) => value !== 'within')) summary.error.push(`${name}: original deadline exceeded or timing uncertain`)
}
const caseScopes = new Set(events.filter((event) => expected.some(([name]) => event.phase === `${name}:test-start`)).map((event) => event.scope))
summary.operationCounters = [...counts].map(([key, value]) => ({ key: JSON.parse(key), ...value })).filter((row) => caseScopes.has(row.key[0])).sort((a, b) => b.ns - a.ns).slice(0, 30)
console.log(JSON.stringify(summary))
if (summary.error.length) process.exitCode = 1
