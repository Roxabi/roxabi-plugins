import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

type Project = 'unit' | 'integration'
type FileEntry = { file: string; project: Project }
type Result = { name: string; status: string; startTime: number; endTime: number }
type Report = { success: boolean; testResults: Result[] }
type Plan = { expected: FileEntry[]; shards: string[][] }

export function partition(files: string[], timings: Record<string, number>, count: number): string[][] {
  const known = files.map((file) => timings[file]).filter((n): n is number => Number.isFinite(n) && n > 0)
  known.sort((a, b) => a - b)
  const middle = Math.floor(known.length / 2)
  const fallback = known.length === 0 ? 1 : known.length % 2 ? known[middle] : (known[middle - 1] + known[middle]) / 2
  const weight = (file: string) => (Number.isFinite(timings[file]) && timings[file] > 0 ? timings[file] : fallback)
  const shards = Array.from({ length: count }, () => [] as string[])
  const loads = Array.from({ length: count }, () => 0)
  for (const file of [...files].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0))) {
    const index = loads.indexOf(Math.min(...loads))
    shards[index].push(file)
    loads[index] += weight(file)
  }
  return shards
}

function normalise(file: string, root: string): string {
  return (isAbsolute(file) ? relative(root, file) : file).replaceAll('\\', '/')
}

export function verifyCoverage(plan: Plan, reports: (Report | undefined)[], root: string): Record<string, number> {
  if (reports.length !== plan.shards.length + 1 || reports.some((report) => !report)) throw new Error('Missing report')
  const expected = new Map(plan.expected.map(({ project, file }) => [`${project}:${file}`, 0]))
  if (expected.size !== plan.expected.length) throw new Error('Duplicate expected file')
  const timings: Record<string, number> = {}
  for (const [index, report] of reports.entries()) {
    if (!report || !report.success || !Array.isArray(report.testResults)) throw new Error('Failed or invalid report')
    const project = index === 0 ? 'unit' : 'integration'
    const assigned = index === 0 ? undefined : new Set(plan.shards[index - 1])
    for (const result of report.testResults) {
      const file = normalise(result.name, root)
      const key = `${project}:${file}`
      if (!expected.has(key) || (assigned && !assigned.has(file))) throw new Error(`Unknown or misplaced file: ${key}`)
      if (result.status !== 'passed') throw new Error(`Failed file: ${key}`)
      const seen = (expected.get(key) ?? 0) + 1
      if (seen !== 1) throw new Error(`Duplicate file: ${key}`)
      expected.set(key, seen)
      if (!Number.isFinite(result.startTime) || !Number.isFinite(result.endTime) || result.endTime < result.startTime) {
        throw new Error(`Invalid duration: ${key}`)
      }
      if (project === 'integration') timings[file] = (result.endTime - result.startTime) / 1000
    }
  }
  const missing = [...expected].filter(([, seen]) => seen !== 1).map(([key]) => key)
  if (missing.length) throw new Error(`Missing files: ${missing.join(', ')}`)
  return timings
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'plan') {
    const [listingPath, timingsPath, outputPath] = args
    const listing = readJson<{ file: string; projectName: Project }[]>(listingPath)
    const expected = listing.map(({ file, projectName }) => ({
      file: normalise(file, process.cwd()),
      project: projectName,
    }))
    if (expected.some(({ project }) => project !== 'unit' && project !== 'integration'))
      throw new Error('Unknown project')
    const integration = expected.filter(({ project }) => project === 'integration').map(({ file }) => file)
    if (integration.length < 8 || !expected.some(({ project }) => project === 'unit'))
      throw new Error('Insufficient test files')
    let timings: Record<string, number> = {}
    if (existsSync(timingsPath)) timings = readJson<Record<string, number>>(timingsPath)
    const plan: Plan = { expected, shards: partition(integration, timings, 8) }
    writeJson(outputPath, plan)
    console.log(JSON.stringify({ include: plan.shards.map((files, index) => ({ shard: index + 1, files })) }))
  } else if (command === 'verify') {
    const [planPath, reportsDir, timingsPath] = args
    const plan = readJson<Plan>(planPath)
    const paths = ['unit', ...plan.shards.map((_, i) => `integration-${i + 1}`)]
    const reports = paths.map((name) => {
      const path = resolve(reportsDir, name, 'report.json')
      return existsSync(path) ? readJson<Report>(path) : undefined
    })
    writeJson(timingsPath, verifyCoverage(plan, reports, process.cwd()))
    console.log(`Verified ${plan.expected.length} files across ${reports.length} reports`)
  } else {
    throw new Error('Usage: ci-test-shards.ts plan <listing> <timings> <plan> | verify <plan> <reports-dir> <timings>')
  }
}
