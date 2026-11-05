// TEMPORARY #905: remove after the hosted observation.
import { appendFileSync } from 'node:fs'
import path from 'node:path'
import { snapshot905Resources } from './feature-review-905-resources.ts'

export function create905Cut(trace: string | undefined, statePath?: string) {
  return (name: string) => {
    if (!trace) return
    try {
      const at = performance.timeOrigin + performance.now()
      const cpu = process.cpuUsage()
      let resources: unknown
      try {
        resources = snapshot905Resources(trace, name === 'initial-review' || name === 'sandbox-end', statePath)
      } catch {
        resources = { available: false, reason: 'snapshot-error' }
      }
      appendFileSync(
        path.join(trace, 'stages.jsonl'),
        `${JSON.stringify({
          name,
          at,
          pid: process.pid,
          cpu,
          resources,
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
