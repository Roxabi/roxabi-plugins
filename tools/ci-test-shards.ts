import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

type Project = 'unit' | 'integration'
type FileEntry = { file: string; project: Project }
type Result = {
  file: string
  project: Project
  state: string
  passed: number
  failed: number
  skipped: number
  pending: number
  duration: number
}
type Report = { success: boolean; modules: Result[] }
type Plan = { expected: FileEntry[]; shards: string[][] }

export function literalIncludes(json: string): string[] {
  const files: unknown = JSON.parse(json)
  if (!Array.isArray(files) || files.some((file) => typeof file !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(file))) {
    throw new Error('Unsafe integration test path: only letters, digits, dot, underscore, slash and hyphen are allowed')
  }
  return files
}

export function parseTimings(json: string): { timings: Record<string, number>; warning: boolean } {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return { timings: {}, warning: true }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { timings: {}, warning: true }
  const timings: Record<string, number> = {}
  let warning = false
  for (const [file, duration] of Object.entries(value)) {
    if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) warning = true
    else timings[file] = duration
  }
  return { timings, warning }
}

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
    if (report?.success !== true || !Array.isArray(report.modules)) throw new Error('Failed or invalid report')
    const project = index === 0 ? 'unit' : 'integration'
    const assigned = index === 0 ? undefined : new Set(plan.shards[index - 1])
    for (const result of report.modules) {
      const file = normalise(result.file, root)
      const key = `${project}:${file}`
      if (result.project !== project || !expected.has(key) || (assigned && !assigned.has(file)))
        throw new Error(`Unknown or misplaced file: ${key}`)
      if (
        result.state !== 'passed' ||
        !Number.isInteger(result.passed) ||
        result.passed < 1 ||
        result.failed !== 0 ||
        result.pending !== 0 ||
        !Number.isInteger(result.skipped) ||
        result.skipped < 0
      )
        throw new Error(`Failed file or no passing tests: ${key}`)
      const seen = (expected.get(key) ?? 0) + 1
      if (seen !== 1) throw new Error(`Duplicate file: ${key}`)
      expected.set(key, seen)
      if (!Number.isFinite(result.duration) || result.duration < 0) throw new Error(`Invalid duration: ${key}`)
      if (project === 'integration') timings[file] = result.duration / 1000
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
    literalIncludes(JSON.stringify(integration))
    if (integration.length < 8 || !expected.some(({ project }) => project === 'unit'))
      throw new Error('Insufficient test files')
    let timings: Record<string, number> = {}
    if (existsSync(timingsPath)) {
      try {
        const parsed = parseTimings(readFileSync(timingsPath, 'utf8'))
        timings = parsed.timings
        if (parsed.warning) console.error('::warning::Ignoring invalid cached test timings')
      } catch {
        console.error('::warning::Unable to read cached test timings; using defaults')
      }
    }
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
