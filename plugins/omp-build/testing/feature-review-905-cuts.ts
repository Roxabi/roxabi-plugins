// TEMPORARY #905: remove after the hosted observation.
import { appendFileSync } from 'node:fs'
import path from 'node:path'

export function create905Cut(trace: string | undefined) {
  return (name: string) => {
    if (!trace) return
    try {
      appendFileSync(
        path.join(trace, 'stages.jsonl'),
        `${JSON.stringify({
          name,
          at: performance.timeOrigin + performance.now(),
          pid: process.pid,
          cpu: process.cpuUsage(),
        })}\n`,
      )
    } catch {
      // A missing observation must not change the fixture result.
    }
  }
}

export function create905Stage(trace: string | undefined) {
  const cut = create905Cut(trace)
  const current = { stage: 'initial-review' }
  cut(current.stage)
  return {
    current,
    next: (stage: string) => {
      current.stage = stage
      cut(stage)
    },
  }
}
