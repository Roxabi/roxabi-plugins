#!/usr/bin/env bun

import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { FRAMING_PROCEDURE_FILES } from '../plugins/omp-build/engine/framing-context-schema.ts'
import { createFreshOutputRoot, outputTree, type RemoveOutput } from './omp-build-output-tree.ts'

// Inputs record actual runtime reads and the contracts bundle closure; the verifier validates producer static imports.
type OutputRecorder = { claim(path: string): void; wrote(path: string): void; paths(): string[] }
type BuildReport = { outputs: string[]; inputs: string[] }

const repositoryRoot = resolve(import.meta.dirname, '..')
const requiredBun = readFileSync(join(repositoryRoot, '.bun-version'), 'utf8').trim()
const pluginRoot = join(repositoryRoot, 'plugins/omp-build')
const issueTriageSource = join(repositoryRoot, 'plugins/issue-triage')
const issueTriageSlice = [
  'skills/issue-triage/lib/init.ts',
  'skills/issue-triage/lib/migrate-labels.ts',
  'skills/issue-triage/templates/issue-tracker.md',
  'skills/shared/adapters/config-helpers.ts',
  'skills/shared/adapters/github-adapter.ts',
  'skills/shared/adapters/issue-writer.ts',
  'skills/shared/domain/complexity.ts',
  'skills/shared/domain/errors.ts',
  'skills/shared/domain/issue-types.ts',
  'skills/shared/domain/issue-write.ts',
  'skills/shared/domain/types.ts',
  'skills/shared/queries.ts',
] as const

function outputRootFromArgs(args: string[]): string | undefined {
  if (args.length === 0) return undefined
  if (args.length === 2 && args[0] === '--output-root' && args[1]) return resolve(args[1])
  throw new Error('usage: bun tools/build-omp-build-contracts.ts [--output-root <fresh-owned-directory>]')
}

function outputRecorder(root: string, checkWrite: (path: string) => void): OutputRecorder {
  const claimed = new Set<string>()
  const written = new Set<string>()
  const nameOf = (path: string): string => {
    const name = relative(root, path).split(sep).join('/')
    if (name === '' || name === '..' || name.startsWith('../') || isAbsolute(name))
      throw new Error(`omp-build output escapes destination: ${path}`)
    return name
  }
  return {
    claim(path) {
      const name = nameOf(path)
      if (claimed.has(name)) throw new Error(`omp-build output collision: ${name}`)
      checkWrite(path)
      claimed.add(name)
    },
    wrote(path) {
      const name = nameOf(path)
      if (!claimed.has(name) || !existsSync(path))
        throw new Error(`omp-build output was not successfully written: ${name}`)
      written.add(name)
    },
    paths: () => [...written].sort(),
  }
}

function copyAgentSources(agentDirectory: string, recorder: OutputRecorder, inputs: Set<string>): void {
  const sourceDirectory = join(pluginRoot, 'agent-sources')
  const files = readdirSync(sourceDirectory)
    .filter((file) => file.endsWith('.md'))
    .sort()
  if (files.length === 0) throw new Error('omp-build agent source directory is empty')
  for (const file of files) {
    const source = join(sourceDirectory, file)
    const destination = join(agentDirectory, file)
    recorder.claim(destination)
    copyFileSync(source, destination)
    recorder.wrote(destination)
    inputs.add(relative(repositoryRoot, source))
  }
}

function copyIssueTriageSlice(distDirectory: string, recorder: OutputRecorder, inputs: Set<string>): void {
  const missing = issueTriageSlice.filter((path) => !existsSync(join(issueTriageSource, path)))
  if (missing.length > 0) throw new Error(`issue-triage runtime slice missing source: ${missing.join(', ')}`)
  for (const path of issueTriageSlice) {
    const source = join(issueTriageSource, path)
    const destination = join(distDirectory, 'issue-triage', path)
    recorder.claim(destination)
    copyFileSync(source, destination)
    recorder.wrote(destination)
    inputs.add(relative(repositoryRoot, source))
  }
}

function requirePinnedBun(): void {
  if (Bun.version !== requiredBun)
    throw new Error(`omp-build production requires Bun ${requiredBun}; found ${Bun.version}`)
}

function inputsOf(metafile: { inputs: Record<string, unknown> } | undefined, entrypoint: string): string[] {
  if (metafile === undefined) throw new Error(`metafile missing for ${entrypoint}`)
  const inputs = Object.keys(metafile.inputs).map((path) => relative(repositoryRoot, resolve(path)))
  if (inputs.length === 0 || !inputs.includes(relative(repositoryRoot, entrypoint)))
    throw new Error(`metafile input closure is incomplete for ${entrypoint}`)
  return inputs
}

async function buildOmpBuildContracts(outputRoot: string | undefined, remove?: RemoveOutput): Promise<BuildReport> {
  requirePinnedBun()
  const root =
    outputRoot === undefined
      ? pluginRoot
      : createFreshOutputRoot(outputRoot, [join(repositoryRoot, 'plugins'), import.meta.dirname])
  const tree = outputTree(root)
  const agentDirectory = join(root, 'agents')
  const distDirectory = join(root, 'dist')
  const inputs = new Set<string>()
  for (const file of Object.values(FRAMING_PROCEDURE_FILES)) {
    const path = join(pluginRoot, file)
    readFileSync(path)
    inputs.add(relative(repositoryRoot, path))
  }
  const recorder = outputRecorder(root, tree.checkWrite)
  copyAgentSources(agentDirectory, recorder, inputs)
  copyIssueTriageSlice(distDirectory, recorder, inputs)
  const entrypoint = join(pluginRoot, 'contracts.ts')
  const result = await Bun.build({
    entrypoints: [entrypoint],
    target: 'node',
    format: 'esm',
    metafile: true,
    throw: false,
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    throw new Error('omp-build contracts bundle failed')
  }
  for (const output of result.outputs) {
    if (isAbsolute(output.path) || output.path.includes('\\') || output.path.split('/').includes('..'))
      throw new Error(`omp-build bundle output is not a safe relative path: ${output.path}`)
    const destination = resolve(distDirectory, output.path)
    const bytes = new Uint8Array(await output.arrayBuffer())
    recorder.claim(destination)
    writeFileSync(destination, bytes)
    recorder.wrote(destination)
  }
  const declaration = join(distDirectory, 'contracts.d.ts')
  recorder.claim(declaration)
  writeFileSync(declaration, "export * from '../contracts.ts'\n")
  recorder.wrote(declaration)
  for (const path of inputsOf(result.metafile, entrypoint)) inputs.add(path)
  const outputs = recorder.paths()
  if (outputRoot === undefined) tree.prune(new Set(outputs), remove)
  return { outputs, inputs: [...inputs].sort() }
}

export async function runProducer(args: string[], remove?: RemoveOutput): Promise<void> {
  console.log(JSON.stringify(await buildOmpBuildContracts(outputRootFromArgs(args), remove)))
}

if (import.meta.main) await runProducer(process.argv.slice(2))
