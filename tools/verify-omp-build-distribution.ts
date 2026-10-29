#!/usr/bin/env bun

import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  type Stats,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { verifyCleanExtension } from './omp-build-clean-extension.ts'
import { compare, gitBytes, headOutputs, type Snapshot, snapshot } from './omp-build-distribution-files.ts'

type BuildReport = { outputs: string[]; inputs: string[] }
type BuildResult = { files: Snapshot }
type Receipt = {
  commit: string
  bun: string
  managedFiles: number
  comparisons: string[]
  negativeProbes: number
  full: boolean
}

const repositoryRoot = resolve(import.meta.dirname, '..')
const pluginRoot = join(repositoryRoot, 'plugins/omp-build')
const buildScript = 'tools/build-omp-build-contracts.ts'
const verifierScript = 'tools/verify-omp-build-distribution.ts'
const requiredBun = readFileSync(join(repositoryRoot, '.bun-version'), 'utf8').trim()

function command(root: string, executable: string, args: string[]): string {
  try {
    return execFileSync(executable, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    const result = error as { stderr?: string; stdout?: string; status?: number }
    throw new Error(
      `${executable} ${args.join(' ')} failed (${result.status ?? 'unknown'}): ${(result.stderr ?? result.stdout ?? '').trim()}`,
    )
  }
}

function inside(root: string, path: string): boolean {
  const value = relative(root, path)
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`))
}

function requirePhysicalDependencies(root: string): string {
  const path = join(root, 'node_modules')
  let entry: Stats
  try {
    entry = lstatSync(path)
  } catch {
    throw new Error(`${root}: node_modules is missing; install dependencies in this physical checkout first`)
  }
  if (entry.isSymbolicLink() || !entry.isDirectory())
    throw new Error(
      `${root}: node_modules must be an owned physical directory; preserve shared dependencies and install this checkout separately`,
    )
  return path
}

function requireOwnedPath(root: string, path: string): void {
  const target = realpathSync(path)
  if (!inside(root, target)) throw new Error(`static input escapes its checkout: ${path} -> ${target}`)
}

function requireHeadFile(root: string, path: string): void {
  const source = join(root, path)
  requireOwnedPath(root, source)
  const expected = gitBytes(root, ['show', `HEAD:${path}`])
  const actual = readFileSync(source)
  if (!actual.equals(expected)) throw new Error(`physical source differs from HEAD: ${path}`)
}

async function requireStaticInputs(root: string): Promise<void> {
  const entries = [buildScript, verifierScript]
  const closure = await Bun.build({
    entrypoints: entries.map((entry) => join(root, entry)),
    target: 'bun',
    format: 'esm',
    metafile: true,
    treeShaking: false,
  })
  if (!closure.success || closure.metafile === undefined) throw new Error('static closure inspection failed')
  const inputs = Object.keys(closure.metafile.inputs).map((path) => relative(root, resolve(path)))
  if (inputs.length === 0 || !entries.every((entry) => inputs.includes(entry)))
    throw new Error('static closure is incomplete')
  requireOwnedInputs(root, inputs)
}

function requireOwnedInputs(root: string, inputs: string[]): void {
  const modules = requirePhysicalDependencies(root)
  for (const input of inputs) {
    const path = resolve(root, input)
    if (!inside(root, path)) throw new Error(`static input is outside its checkout: ${input}`)
    if (inside(modules, path)) requireOwnedPath(modules, path)
    else requireHeadFile(root, relative(root, path))
  }
}

function reportFrom(output: string): BuildReport {
  let value: unknown
  try {
    value = JSON.parse(output)
  } catch {
    throw new Error(`producer did not return a JSON build report: ${output}`)
  }
  if (typeof value !== 'object' || value === null) throw new Error('producer build report is not an object')
  const report = value as { outputs?: unknown; inputs?: unknown }
  if (
    !Array.isArray(report.outputs) ||
    !Array.isArray(report.inputs) ||
    !report.outputs.every((path) => typeof path === 'string') ||
    !report.inputs.every((path) => typeof path === 'string')
  )
    throw new Error('producer build report has invalid paths')
  return { outputs: report.outputs, inputs: report.inputs }
}

function assertInventory(report: BuildReport, files: Snapshot): void {
  const actual = [...files.keys()].sort()
  const expected = [...report.outputs].sort()
  if (new Set(expected).size !== expected.length || expected.join('\n') !== actual.join('\n'))
    throw new Error(
      `producer report does not match physical outputs: reported=[${expected.join(', ')}] actual=[${actual.join(', ')}]`,
    )
}

function build(root: string, outputRoot: string): BuildResult {
  const report = reportFrom(command(root, process.execPath, [buildScript, '--output-root', outputRoot]).trim())
  const files = snapshot(outputRoot)
  assertInventory(report, files)
  requireOwnedInputs(root, report.inputs)
  return { files }
}

function currentCommit(root: string): string {
  return command(root, 'git', ['rev-parse', 'HEAD']).trim()
}

function cloneCandidate(root: string, target: string, commit: string): void {
  command(root, 'git', ['clone', '--no-local', '--no-checkout', root, target])
  command(target, 'git', ['checkout', '--detach', commit])
}

function expectSpecificFailure(label: string, needle: string, action: () => void): void {
  try {
    action()
  } catch (error) {
    if (String(error).includes(needle)) return
    throw new Error(`${label} failed without ${JSON.stringify(needle)}: ${String(error)}`)
  }
  throw new Error(`${label} did not fail`)
}

function probeVerifier(checkout: string, label: string, needle: string): void {
  expectSpecificFailure(label, needle, () => command(checkout, process.execPath, [verifierScript, '--no-probes']))
}

function negativeProbes(checkout: string, expected: Snapshot): void {
  const [path, bytes] = [...expected][0] ?? []
  if (path === undefined || bytes === undefined) throw new Error('cannot construct generated-output probes')
  const target = join(checkout, 'plugins/omp-build', path)
  writeFileSync(target, 'changed')
  try {
    probeVerifier(checkout, 'changed output', `candidate to A: missing=[] extra=[] changed=[${path}]`)
  } finally {
    writeFileSync(target, bytes)
  }
  rmSync(target)
  try {
    probeVerifier(checkout, 'missing output', `candidate to A: missing=[${path}] extra=[] changed=[]`)
  } finally {
    writeFileSync(target, bytes)
  }
  const orphan = join(checkout, 'plugins/omp-build/agents/orphan.md')
  writeFileSync(orphan, 'orphan')
  try {
    probeVerifier(checkout, 'orphan output', 'candidate to A: missing=[] extra=[agents/orphan.md] changed=[]')
  } finally {
    rmSync(orphan)
  }
}

function collisionProbe(checkout: string, expected: Snapshot, owned: string): void {
  const sourceDirectory = join(checkout, 'plugins/omp-build/agent-sources')
  const sources = new Set(readdirSync(sourceDirectory).filter((name) => name.endsWith('.md')))
  const profile = [...expected.keys()]
    .filter((path) => path.startsWith('agents/') && !sources.has(path.slice('agents/'.length)))
    .sort()[0]
  const source = [...sources].sort()[0]
  if (profile === undefined || source === undefined) throw new Error('cannot construct owned collision probe')
  const collision = join(sourceDirectory, profile.slice('agents/'.length))
  copyFileSync(join(sourceDirectory, source), collision)
  try {
    expectSpecificFailure('producer collision', 'omp-build output collision:', () =>
      command(checkout, process.execPath, [buildScript, '--output-root', join(owned, 'collision-output')]),
    )
  } finally {
    rmSync(collision)
  }
}

async function verify(root: string, probes: boolean): Promise<Receipt> {
  if (Bun.version !== requiredBun)
    throw new Error(`distribution verification requires Bun ${requiredBun}; found ${Bun.version}`)
  requireHeadFile(root, '.bun-version')
  requireHeadFile(root, 'bun.lock')
  requireHeadFile(root, buildScript)
  requireHeadFile(root, verifierScript)
  requirePhysicalDependencies(root)
  const candidate = snapshot(pluginRoot)
  const commit = currentCommit(root)
  await requireStaticInputs(root)
  const owned = mkdtempSync(join(tmpdir(), 'omp-build-distribution-'))
  try {
    const a = build(root, join(owned, 'a'))
    compare('candidate to A', a.files, candidate)
    compare('candidate to HEAD', headOutputs(root), candidate)
    const checkout = join(owned, 'b')
    cloneCandidate(root, checkout, commit)
    requireHeadFile(checkout, '.bun-version')
    requireHeadFile(checkout, 'bun.lock')
    requireHeadFile(checkout, buildScript)
    requireHeadFile(checkout, verifierScript)
    command(checkout, process.execPath, ['install', '--frozen-lockfile', '--backend=copyfile'])
    await requireStaticInputs(checkout)
    const installed = snapshot(join(checkout, 'plugins/omp-build'))
    compare('B installed surface to HEAD', headOutputs(checkout), installed)
    const b = build(checkout, join(owned, 'b-output'))
    compare('A to B', a.files, b.files)
    requireOwnedPath(requirePhysicalDependencies(checkout), join(checkout, 'node_modules/@oh-my-pi/pi-coding-agent'))
    verifyCleanExtension(checkout, owned)
    if (probes) {
      negativeProbes(checkout, b.files)
      collisionProbe(checkout, b.files, owned)
    }
  } finally {
    rmSync(owned, { recursive: true, force: true })
  }
  return {
    commit,
    bun: Bun.version,
    managedFiles: candidate.size,
    comparisons: ['candidate=A', 'candidate=HEAD', 'B-installed=HEAD', 'A=B'],
    negativeProbes: probes ? 4 : 0,
    full: probes,
  }
}

const args = process.argv.slice(2)
if (args.length > 1 || (args.length === 1 && args[0] !== '--no-probes'))
  throw new Error('usage: bun tools/verify-omp-build-distribution.ts [--no-probes]')
console.log(JSON.stringify(await verify(repositoryRoot, args.length === 0)))
