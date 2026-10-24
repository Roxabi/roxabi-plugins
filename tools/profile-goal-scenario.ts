#!/usr/bin/env bun
/**
 * Ephemeral profiler for the goal scenario while the complete Vitest suite runs.
 *
 * The checkout remains unchanged. Vitest resolves only the scenario sandbox to a
 * generated, byte-for-byte-derived copy whose process boundaries emit JSONL
 * timings. The original test, workflow, driver, simulator, state, and assertions
 * remain in use.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repo = path.resolve(process.argv[2] ?? process.cwd())
const sandbox = path.join(repo, 'plugins/omp-build/skills/feature/testing/goal/goal-scenario-sandbox.ts')
const workflow = path.join(repo, 'plugins/omp-build/skills/feature/testing/goal/goal-scenario-workflow.ts')
const driver = path.join(repo, 'plugins/omp-build/skills/feature/epic-driver.ts')
const simulator = path.join(repo, 'plugins/omp-build/skills/feature/testing/gh-simulator/gh-simulator.ts')
const vitest = path.join(repo, 'node_modules/vitest/vitest.mjs')
const domain = path.join(repo, 'plugins/omp-build/skills/feature/testing/goal/goal-scenario-domain.ts')

for (const file of [sandbox, workflow, driver, simulator, vitest, domain]) {
  try {
    readFileSync(file)
  } catch {
    throw new Error(`required path is unreadable: ${file}`)
  }
}

const root = mkdtempSync(path.join(tmpdir(), 'omp-goal-scenario-profile-'))
const trace = path.join(tmpdir(), `omp-goal-scenario-profile-${process.pid}.jsonl`)
const helper = path.join(root, 'goal-scenario-sandbox.profile.ts')
const config = path.join(root, 'vitest.profile.config.mts')
const ghWrapper = path.join(root, 'gh.profile.ts')
const workflowWrapper = path.join(root, 'workflow.profile.ts')

writeFileSync(trace, '')

const literal = (value: string) => JSON.stringify(value)

const wrapper = (kind: string, entry: string) => `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs'
const trace = process.env.GOAL_SCENARIO_PROFILE
const started = performance.now()
const command = process.argv.slice(2)
const log = (event: Record<string, unknown>) => {
  if (trace) appendFileSync(trace, JSON.stringify(event) + '\\n')
}
const originalSpawn = Bun.spawn
Bun.spawn = ((args: string[], options?: Record<string, unknown>) => {
  const began = performance.now()
  const proc = originalSpawn(args, options)
  void proc.exited.then(
    (code) => log({ layer: ${literal(kind)}, boundary: 'Bun.spawn', command: args, ms: performance.now() - began, code }),
    (error) => log({ layer: ${literal(kind)}, boundary: 'Bun.spawn', command: args, ms: performance.now() - began, error: String(error) }),
  )
  return proc
}) as typeof Bun.spawn
process.on('exit', (code) => log({ layer: ${literal(kind)}, boundary: 'process', command, ms: performance.now() - started, code }))
await import(${literal(entry)})
`

writeFileSync(ghWrapper, wrapper('gh-cli', simulator))
writeFileSync(workflowWrapper, wrapper('workflow', workflow))
chmodSync(ghWrapper, 0o755)
chmodSync(workflowWrapper, 0o755)

const source = readFileSync(sandbox, 'utf8')
const instrumented = source
  .replace(
    "import { execFileSync, spawnSync } from 'node:child_process'",
    `import { execFileSync as sourceExecFileSync, spawnSync as sourceSpawnSync } from 'node:child_process'\nimport { appendFileSync } from 'node:fs'\n\nconst profileTrace = process.env.GOAL_SCENARIO_PROFILE\nfunction profileBoundary(boundary: string, args: unknown[], invoke: () => unknown): unknown {\n  const started = performance.now()\n  let code: number | null | undefined\n  let failure: string | undefined\n  try {\n    const result = invoke() as { status?: number | null }\n    code = result?.status\n    return result\n  } catch (error) {\n    failure = error instanceof Error ? error.message : String(error)\n    throw error\n  } finally {\n    if (profileTrace) appendFileSync(profileTrace, JSON.stringify({ layer: 'sandbox', boundary, command: args.map(String), ms: performance.now() - started, code, failure }) + '\\n')\n  }\n}\nconst execFileSync = (...args: any[]) => profileBoundary('execFileSync', args, () => Reflect.apply(sourceExecFileSync as any, undefined, args)) as ReturnType<typeof sourceExecFileSync>\nconst spawnSync = (...args: any[]) => profileBoundary('spawnSync', args, () => Reflect.apply(sourceSpawnSync as any, undefined, args)) as ReturnType<typeof sourceSpawnSync>`,
  )
  .replace(
    "const DRIVER = path.resolve(import.meta.dirname, '..', '..', 'epic-driver.ts')",
    `const DRIVER = ${literal(driver)}`,
  )
  .replace(
    "const SIM = path.resolve(import.meta.dirname, '..', 'gh-simulator', 'gh-simulator.ts')",
    `const SIM = ${literal(ghWrapper)}`,
  )
  .replace(
    "const WORKFLOW = path.resolve(import.meta.dirname, 'goal-scenario-workflow.ts')",
    `const WORKFLOW = ${literal(workflowWrapper)}`,
  )
  .replace("} from './goal-scenario-domain.ts'", `} from ${literal(domain)}`)

for (const required of ['profileBoundary', ghWrapper, workflowWrapper, domain]) {
  if (!instrumented.includes(required)) throw new Error(`sandbox transformation missing: ${required}`)
}

if (instrumented === source) throw new Error('sandbox instrumentation did not apply')
writeFileSync(helper, instrumented)

writeFileSync(
  config,
  `import base from ${literal(path.join(repo, 'vitest.config.ts'))}\n\nconst existing = base as Record<string, any>\nconst resolve = (existing.resolve ??= {})\nconst aliases = Array.isArray(resolve.alias) ? resolve.alias : resolve.alias ? Object.entries(resolve.alias).map(([find, replacement]) => ({ find, replacement })) : []\naliases.unshift({ find: /^(?:.*\\/)?goal-scenario-sandbox\\.ts$/, replacement: ${literal(helper)} })\nresolve.alias = aliases\nexport default existing\n`,
)

type TraceRow = {
  layer: string
  boundary: string
  command: unknown
  ms: number
  code?: number | null
  error?: string
  failure?: string
}

type Summary = {
  count: number
  total: number
  samples: number[]
  failures: number
}

function commandTokens(command: unknown): string[] {
  if (Array.isArray(command)) return command.flatMap(commandTokens)
  return [String(command)]
}

function safeCommand(command: unknown): string {
  const tokens = commandTokens(command)
  const safe: string[] = []
  let redactNext = false

  for (const token of tokens) {
    if (redactNext) {
      safe.push('<REDACTED>')
      redactNext = false
      continue
    }

    if (/^(?:--body|--form|-f|--raw-field|--field)$/.test(token)) {
      safe.push(token)
      redactNext = true
      continue
    }

    if (
      /^(?:--body|--form|-f|--raw-field|--field)=/.test(token) ||
      /(?:^|[,\s])(?:--body|--form|-f|--raw-field|--field)(?:=|[,\s])/.test(token)
    ) {
      safe.push('<REDACTED payload arguments>')
      continue
    }

    if (token.includes('\n') || token.includes('\r')) {
      safe.push('<REDACTED multiline payload>')
      continue
    }

    safe.push(token.length > 120 ? `${token.slice(0, 117)}...` : token)
  }

  return safe.join(' ').slice(0, 400)
}

function commandFamily(row: TraceRow): string {
  const tokens = commandTokens(row.command)
  const first = tokens[0] ?? 'unknown'
  const second = tokens[1]
  return second && !second.startsWith('-') ? `${path.basename(first)} ${second}` : path.basename(first)
}

function percentile(samples: number[], value: number): number {
  const index = Math.min(samples.length - 1, Math.max(0, Math.ceil((samples.length * value) / 100) - 1))
  return samples[index]
}

function report(rows: TraceRow[]): void {
  console.error(`\n[goal-scenario-profile] raw=${trace}`)
  console.error(`[goal-scenario-profile] trace events=${rows.length}`)

  const groups = new Map<string, Summary>()
  for (const row of rows) {
    const key = `${row.layer}\t${row.boundary}\t${commandFamily(row)}`
    const group = groups.get(key) ?? { count: 0, total: 0, samples: [], failures: 0 }
    group.count++
    group.total += row.ms
    group.samples.push(row.ms)
    if ((row.code !== undefined && row.code !== null && row.code !== 0) || row.error || row.failure) group.failures++
    groups.set(key, group)
  }

  console.error('[goal-scenario-profile] by layer and command family (descending cumulative milliseconds):')
  for (const [key, group] of [...groups.entries()].sort(([, left], [, right]) => right.total - left.total)) {
    const [layer, boundary, family] = key.split('\t')
    const samples = group.samples.sort((left, right) => left - right)
    console.error(
      `[goal-scenario-profile] ${layer}/${boundary}; ${family}; count=${group.count}; total=${group.total.toFixed(1)}ms; median=${percentile(samples, 50).toFixed(1)}ms; p95=${percentile(samples, 95).toFixed(1)}ms; max=${(samples.at(-1) ?? 0).toFixed(1)}ms; failures=${group.failures}`,
    )
  }

  console.error('[goal-scenario-profile] top 10 individual outliers:')
  for (const row of [...rows].sort((left, right) => right.ms - left.ms).slice(0, 10)) {
    const status = row.code === undefined ? '' : `; code=${row.code}`
    console.error(
      `[goal-scenario-profile] ${row.ms.toFixed(1)}ms; ${row.layer}/${row.boundary}${status}; ${safeCommand(row.command)}`,
    )
  }
}

let exitCode = 1
let rows: TraceRow[] = []
try {
  const child = Bun.spawn([process.execPath, vitest, 'run', '--config', config], {
    cwd: repo,
    env: { ...process.env, GOAL_SCENARIO_PROFILE: trace },
    stdout: 'inherit',
    stderr: 'inherit',
  })
  exitCode = await child.exited
} finally {
  rows = readFileSync(trace, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TraceRow)
  if (rows.length > 0) report(rows)
  rmSync(root, { recursive: true, force: true })
}

if (rows.length === 0) {
  throw new Error(`profiler received no sandbox timings; trace retained at ${trace}`)
}

process.exit(exitCode)
