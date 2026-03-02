import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'

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
  // Prefer source-relative path (when running from repo directly)
  const sourceRelative = join(dirname(import.meta.dir), 'skills/issues/dashboard.ts')
  if (existsSync(sourceRelative)) return sourceRelative

  // Fall back to cache
  const base = join(homedir(), '.claude/plugins/cache/roxabi-marketplace/dev-core')
  if (!existsSync(base)) {
    console.error('dev-core plugin not found. Run: claude plugin install dev-core')
    process.exit(1)
  }

  const dirs = readdirSync(base).filter(
    (d) => !d.startsWith('.') && !existsSync(join(base, d, '.orphaned_at'))
  )
  if (!dirs.length) {
    console.error('dev-core plugin cache is empty. Run: claude plugin install dev-core')
    process.exit(1)
  }

  const latest = dirs.sort(
    (a, b) => statSync(join(base, b)).mtimeMs - statSync(join(base, a)).mtimeMs
  )[0]

  const path = join(base, latest, 'skills/issues/dashboard.ts')
  if (!existsSync(path)) {
    console.error(`dashboard.ts not found in cache: ${path}`)
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
    try { require('fs').unlinkSync(PID_FILE) } catch {}
    process.exit(0)
  }

  const dashboardPath = resolveDashboardPath()

  const proc = Bun.spawn(['bun', dashboardPath, ...args], {
    stdio: ['inherit', 'inherit', 'inherit'],
  })

  writeFileSync(PID_FILE, String(proc.pid))

  const cleanup = () => {
    try { require('fs').unlinkSync(PID_FILE) } catch {}
  }

  process.on('SIGINT', () => { cleanup(); proc.kill('SIGINT'); process.exit(0) })
  process.on('SIGTERM', () => { cleanup(); proc.kill('SIGTERM'); process.exit(0) })

  const code = await proc.exited
  cleanup()
  process.exit(code)
}
