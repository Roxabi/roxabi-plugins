// Temporary Q904 test-child tracing. No argv, environment or payload is recorded.
import { appendFileSync, statSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { basename } from 'node:path'

const file = process.env.Q904_CI_DIAGNOSTIC
if (file) {
  const stats = {}
  let active = 0
  let peak = 0
  const add = (command, elapsed) => {
    const name = ['gh', 'git', 'bun'].includes(basename(command)) ? basename(command) : 'other'
    stats[name] ??= { count: 0, elapsed: 0, max: 0 }
    const item = stats[name]
    item.count++
    item.elapsed += elapsed
    item.max = Math.max(item.max, elapsed)
  }
  const flush = () => {
    try {
      if (statSync(file).size < 2 * 1024 * 1024)
        appendFileSync(
          file,
          `${JSON.stringify({ kind: 'child-processes', time: Date.now(), pid: process.pid, active, peak, stats, cpu: process.cpuUsage() })}\n`,
        )
    } catch {}
  }
  const original = Bun.spawn.bind(Bun)
  Bun.spawn = (...args) => {
    const started = Date.now()
    const argv = Array.isArray(args[0]) ? args[0] : args[0]?.cmd
    const command = String(argv?.[0] ?? '')
    const child = original(...args)
    active++
    peak = Math.max(peak, active)
    child.exited.then(
      () => {
        active--
        add(command, Date.now() - started)
      },
      () => {
        active--
        add(command, Date.now() - started)
      },
    )
    return child
  }
  const cp = createRequire(import.meta.url)('node:child_process')
  const sync = cp.execFileSync
  cp.execFileSync = function (...args) {
    const started = Date.now()
    try {
      return sync.apply(this, args)
    } finally {
      add(String(args[0]), Date.now() - started)
    }
  }
  syncBuiltinESMExports()
  const interval = setInterval(flush, 1000)
  interval.unref()
  process.once('exit', flush)
}
