import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PID_FILE = join(homedir(), '.claude/plugins/cache/roxabi-marketplace/.dashboard.pid')

const USAGE = `
Usage:
  roxabi dashboard [--port=<n>] [--poll=<s>] [--stop]

Options:
  --port=<n>   HTTP port (default: 3333)
  --poll=<s>   Polling interval in seconds (default: 60)
  --stop       Stop the running dashboard
`.trim()

function resolveDashboardPath(): string {
  // Always resolve relative to this file: cli/commands/ → ../../skills/issues/
  // Works from both source repo and plugin cache
  const path = join(import.meta.dir, '../../skills/issues/dashboard.ts')
  if (!existsSync(path)) {
    console.error(`dashboard.ts not found: ${path}`)
    process.exit(1)
  }
  return path
}

export async function run(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE)
    process.exit(0)
  }

  if (args.includes('--stop')) {
    if (!existsSync(PID_FILE)) {
      console.log('No running dashboard found.')
      process.exit(0)
    }
    const pid = parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10)
    try {
      process.kill(pid, 'SIGTERM')
      console.log(`Dashboard (pid ${pid}) stopped.`)
    } catch {
      console.log(`Process ${pid} not found — already stopped.`)
    }
    try {
      require('node:fs').unlinkSync(PID_FILE)
    } catch {}
    process.exit(0)
  }

  const dashboardPath = resolveDashboardPath()

  const proc = Bun.spawn(['bun', dashboardPath, ...args], {
    stdio: ['inherit', 'inherit', 'inherit'],
  })

  writeFileSync(PID_FILE, String(proc.pid))

  const cleanup = () => {
    try {
      require('node:fs').unlinkSync(PID_FILE)
    } catch {}
  }

  process.on('SIGINT', () => {
    cleanup()
    proc.kill('SIGINT')
    process.exit(0)
  })
  process.on('SIGTERM', () => {
    cleanup()
    proc.kill('SIGTERM')
    process.exit(0)
  })

  const code = await proc.exited
  cleanup()
  process.exit(code)
}
