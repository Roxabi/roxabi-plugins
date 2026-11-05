// TEMPORARY #905: remove after the hosted observation.
import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

let sequence = 0
export function goal905Directory(root: string | undefined): string | undefined {
  if (!root) return undefined
  const dir = path.join(root, 'goal')
  try {
    mkdirSync(dir, { recursive: true })
    return dir
  } catch {
    return undefined
  }
}
export function observe905<T>(trace: string | undefined, kind: string, operation: string | undefined, fn: () => T): T {
  if (!trace) return fn()
  const id = ++sequence
  const emit = (event: string, outcome?: string) => {
    try {
      const mono = performance.now()
      appendFileSync(
        path.join(trace, 'envelopes.jsonl'),
        `${JSON.stringify({
          id,
          kind,
          operation,
          event,
          outcome,
          pid: process.pid,
          processOrigin: performance.timeOrigin,
          mono,
          wall: performance.timeOrigin + mono,
          cpu: process.cpuUsage(),
          childPid: null,
        })}\n`,
      )
    } catch {
      // An unavailable observer must not change the invoked operation.
    }
  }
  emit('start')
  let outcome = 'throw'
  try {
    const result = fn()
    outcome = 'return'
    return result
  } finally {
    emit('finish', outcome)
  }
}
