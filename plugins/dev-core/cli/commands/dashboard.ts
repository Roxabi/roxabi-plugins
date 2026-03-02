import { existsSync, readdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const USAGE = `
Usage:
  roxabi dashboard [--port=<n>] [--poll=<s>]

Options:
  --port=<n>   HTTP port (default: 3333)
  --poll=<s>   Polling interval in seconds (default: 60)
`.trim()

export async function run(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE)
    process.exit(0)
  }

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

  const dashboardPath = join(base, latest, 'skills/issues/dashboard.ts')

  if (!existsSync(dashboardPath)) {
    console.error(`dashboard.ts not found in cache: ${dashboardPath}`)
    process.exit(1)
  }

  const proc = Bun.spawn(['bun', dashboardPath, ...args], {
    stdio: ['inherit', 'inherit', 'inherit'],
  })

  process.on('SIGINT', () => {
    proc.kill('SIGINT')
    process.exit(0)
  })
  process.on('SIGTERM', () => {
    proc.kill('SIGTERM')
    process.exit(0)
  })

  process.exit(await proc.exited)
}
