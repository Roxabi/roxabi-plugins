// Temporary Q904 diagnostic; records fixed labels and numeric measurements only.
import { appendFileSync, statSync } from 'node:fs'

export function diagnostic(kind: string, label: string, started?: number, value?: number): void {
  const file = process.env.Q904_CI_DIAGNOSTIC
  if (!file) return
  try {
    if (statSync(file).size < 2 * 1024 * 1024)
      appendFileSync(
        file,
        `${JSON.stringify({ kind, label, time: Date.now(), pid: process.pid, ...(started === undefined ? {} : { elapsed: Date.now() - started }), ...(value === undefined ? {} : { value }), cpu: process.cpuUsage() })}\n`,
      )
  } catch {
    // Diagnostics must not change test outcomes.
  }
}
