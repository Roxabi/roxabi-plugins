import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { fail, type State, stamp } from './sim-types.ts'

export function statePath(): string {
  const path = process.env.GH_SIM_STATE
  if (!path) fail('gh: GH_SIM_STATE is unset')
  return path
}

/** Atomically replace the persisted simulator state. */
export function persist(state: State): void {
  const path = statePath()
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(state))
  renameSync(tmp, path)
}

function acquireLock(lock: string): void {
  const start = Date.now()
  for (;;) {
    try {
      mkdirSync(lock)
      return
    } catch {
      if (Date.now() - start > 10_000) fail(`gh: lock timeout ${lock}`)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1)
    }
  }
}

function hydrateCommentIds(state: State, commentThreads: Array<State['prs'][string] | State['issues'][string]>): void {
  if (state.nextCommentId !== undefined) return
  state.nextCommentId = 0
  for (const thread of commentThreads)
    for (const comment of thread.comments) state.nextCommentId = Math.max(state.nextCommentId, comment.id ?? 0)
}

function hydrateComments(state: State, commentThreads: Array<State['prs'][string] | State['issues'][string]>): void {
  for (const thread of commentThreads) {
    for (const comment of thread.comments) {
      if (!Object.hasOwn(comment, 'id')) comment.id = state.nextCommentId = (state.nextCommentId ?? 0) + 1
      if (!Object.hasOwn(comment, 'createdAt')) comment.createdAt = stamp(state)
      if (!Object.hasOwn(comment, 'updatedAt')) comment.updatedAt = comment.createdAt
    }
  }
}

function hydrateState(state: State): void {
  const commentThreads = [...Object.values(state.prs), ...Object.values(state.issues)]
  hydrateCommentIds(state, commentThreads)
  hydrateComments(state, commentThreads)
}

/** Lock, hydrate legacy comment fields, execute one command, then persist it. */
export function withState<T>(fn: (state: State) => T): T {
  const path = statePath()
  const lock = `${path}.lock`
  // TEMPORARY #905: no argv, environment, or state contents are recorded.
  const trace = process.env.OMP_905_TRACE_DIR
  if (!trace) {
    acquireLock(lock)
    try {
      const state = JSON.parse(readFileSync(path, 'utf8')) as State
      hydrateState(state)
      const result = fn(state)
      persist(state)
      return result
    } finally {
      rmSync(lock, { recursive: true, force: true })
    }
  }
  const times: Record<string, number> = {}
  const mark = (name: string) => {
    if (trace) times[name] = performance.timeOrigin + performance.now()
  }
  const cpu = trace ? process.cpuUsage() : undefined
  let bytes = 0
  let committed = false
  mark('start')
  try {
    acquireLock(lock)
    mark('lock')
    try {
      const raw = readFileSync(path, 'utf8')
      if (trace) bytes = Buffer.byteLength(raw)
      mark('read')
      const state = JSON.parse(raw) as State
      mark('parse')
      hydrateState(state)
      mark('hydrate')
      const result = fn(state)
      mark('handle')
      persist(state)
      committed = true
      mark('persist')
      return result
    } finally {
      rmSync(lock, { recursive: true, force: true })
      mark('unlock')
    }
  } finally {
    if (trace && cpu) {
      try {
        appendFileSync(
          join(trace, 'simulator.jsonl'),
          `${JSON.stringify({
            pid: process.pid,
            ppid: process.ppid,
            times,
            cpu: process.cpuUsage(cpu),
            bytes,
            committed,
          })}\n`,
        )
      } catch {
        // Missing observations are reported separately, not as simulator failures.
      }
    }
  }
}
