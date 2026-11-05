// TEMPORARY #905: remove this diagnostic with the hosted observation.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2]
if (!dir) throw new Error('trace directory required')
type Stage = { name: string; at: number; pid: number; cpu: { user: number; system: number } }
type Call = {
  times: Record<string, number>
  committed: boolean
  bytes: number
  cpu: { user: number; system: number }
}
function records<T>(name: string): T[] {
  const file = join(dir, name)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T)
}
const stages = records<Stage>('stages.jsonl')
const calls = records<Call>('simulator.jsonl')
const phases = ['lock', 'read', 'parse', 'hydrate', 'handle', 'persist', 'unlock']
const sums: Record<string, number> = {}
for (const call of calls) {
  let prior = call.times.start
  for (const phase of phases) {
    const current = call.times[phase]
    if (typeof current === 'number' && typeof prior === 'number') sums[phase] = (sums[phase] ?? 0) + current - prior
    prior = current
  }
}
const start = stages.find((stage) => stage.name === 'test-start')
const deadline = start === undefined ? undefined : start.at + 30_000
const activeAtApproximateDeadline =
  deadline === undefined
    ? undefined
    : stages
        .filter((stage) => stage.at <= deadline)
        .sort((a, b) => a.at - b.at)
        .at(-1)?.name
const summary = {
  diagnostic: stages.length && calls.length ? 'partial-observation' : 'diagnostic-unavailable',
  stages,
  activeAtApproximateDeadline,
  simulatorTransactions: calls.length,
  committed: calls.filter((call) => call.committed).length,
  inputBytes: calls.reduce((sum, call) => sum + call.bytes, 0),
  childTransactionCpuMicros: calls.reduce((sum, call) => sum + call.cpu.user + call.cpu.system, 0),
  phaseWallSumsMs: sums,
  profilePresent: existsSync(join(dir, 'runtime.cpuprofile')),
  limitations:
    'Phase sums overlap across processes; transaction CPU excludes process startup. Missing events or profile are not success evidence.',
}
const output = `${JSON.stringify(summary, null, 2)}\n`
writeFileSync(join(dir, 'summary.json'), output)
process.stdout.write(output)
