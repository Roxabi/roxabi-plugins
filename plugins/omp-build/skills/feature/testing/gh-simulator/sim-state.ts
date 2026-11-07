import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { probeCount, probeScope } from '../../../../testing/diagnostic-probe.ts'
import { currentInvocation } from './sim-invocation.ts'

import { fail, type State, stamp } from './sim-types.ts'

export function statePath(): string {
  const path = currentInvocation().env.GH_SIM_STATE
  if (!path) fail('gh: GH_SIM_STATE is unset')
  return path
}

/** Atomically replace the persisted simulator state. */
export function persist(state: State): void {
  const path = statePath()
  const tmp = `${path}.tmp`
  const started = process.hrtime.bigint()
  const serialized = JSON.stringify(state)
  probeCount(
    probeScope(path),
    'state-serialize',
    'json',
    Number(process.hrtime.bigint() - started),
    Buffer.byteLength(serialized),
  )
  writeFileSync(tmp, serialized)
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
  acquireLock(lock)
  try {
    const readStarted = process.hrtime.bigint()
    const raw = readFileSync(path, 'utf8')
    probeCount(
      probeScope(path),
      'state-read',
      'file',
      Number(process.hrtime.bigint() - readStarted),
      Buffer.byteLength(raw),
    )
    const parseStarted = process.hrtime.bigint()
    const state = JSON.parse(raw) as State
    probeCount(
      probeScope(path),
      'state-parse',
      'json',
      Number(process.hrtime.bigint() - parseStarted),
      Buffer.byteLength(raw),
    )
    hydrateState(state)
    const result = fn(state)
    persist(state)
    return result
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}
