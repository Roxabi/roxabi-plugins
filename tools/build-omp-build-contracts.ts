#!/usr/bin/env bun

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { producerJsonSchema } from '../plugins/omp-build/engine/producer-schema.ts'
import { nativeFeatureProfiles } from '../plugins/omp-build/roxabi/native-feature-profiles.ts'
import { nativeReviewProfiles } from '../plugins/omp-build/roxabi/native-review-profiles.ts'

type GeneratedProfile = {
  name: string
  description: string
  tools: string
  model: string
  maxTurns: number
  output: string
  sourceAgent?: string
  instructions?: string
  body?: string
}

// Inputs record actual runtime reads and the contracts bundle closure; the verifier validates producer static imports.
type OutputRecorder = { claim(path: string): void; wrote(path: string): void; paths(): string[] }
type BuildReport = { outputs: string[]; inputs: string[] }

const repositoryRoot = resolve(import.meta.dirname, '..')
const requiredBun = readFileSync(join(repositoryRoot, '.bun-version'), 'utf8').trim()
const pluginRoot = join(repositoryRoot, 'plugins/omp-build')
const issueTriageSource = join(repositoryRoot, 'plugins/issue-triage')
const issueTriageSlice = [
  'skills/issue-triage/triage.ts',
  'skills/issue-triage/lib/create.ts',
  'skills/issue-triage/lib/set.ts',
  'skills/issue-triage/lib/init.ts',
  'skills/issue-triage/lib/label-flags.ts',
  'skills/issue-triage/lib/migrate-labels.ts',
  'skills/issue-triage/lib/list.ts',
  'skills/issue-triage/templates/issue-tracker.md',
  'skills/shared/adapters/config-helpers.ts',
  'skills/shared/adapters/github-adapter.ts',
  'skills/shared/adapters/github-infra.ts',
  'skills/shared/domain/cli-args.ts',
  'skills/shared/domain/errors.ts',
  'skills/shared/domain/issue-types.ts',
  'skills/shared/domain/parse-issue-ref.ts',
  'skills/shared/domain/types.ts',
  'skills/shared/queries.ts',
] as const

function outputRootFromArgs(args: string[]): string {
  if (args.length === 0) return pluginRoot
  if (args.length === 2 && args[0] === '--output-root') return resolve(args[1])
  throw new Error('usage: bun tools/build-omp-build-contracts.ts [--output-root <fresh-owned-directory>]')
}

function bodyOf(path: string, inputs: Set<string>): string {
  inputs.add(relative(repositoryRoot, path))
  const source = readFileSync(path, 'utf8')
  const end = source.indexOf('\n---\n', 4)
  if (!source.startsWith('---\n') || end === -1) throw new Error(`agent profile ${path} has no frontmatter`)
  return source.slice(end + 5).trim()
}

function profileBody(profile: GeneratedProfile, inputs: Set<string>): string {
  const body = profile.sourceAgent === undefined ? profile.body : bodyOf(join(pluginRoot, profile.sourceAgent), inputs)
  if (body === undefined) throw new Error(`native profile ${profile.name} has no body source`)
  return profile.instructions === undefined ? body : `${body}\n\n${profile.instructions}`
}

function outputRecorder(root: string): OutputRecorder {
  const claimed = new Set<string>()
  const written = new Set<string>()
  const nameOf = (path: string): string => {
    const name = relative(root, resolve(path)).split('\\').join('/')
    if (name === '' || name.startsWith('../')) throw new Error(`omp-build output escapes destination: ${path}`)
    return name
  }
  return {
    claim(path) {
      const name = nameOf(path)
      if (claimed.has(name)) throw new Error(`omp-build output collision: ${name}`)
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

function writeProfile(
  agentDirectory: string,
  profile: GeneratedProfile,
  recorder: OutputRecorder,
  inputs: Set<string>,
): void {
  const destination = join(agentDirectory, `${profile.name}.md`)
  recorder.claim(destination)
  writeFileSync(
    destination,
    [
      '---',
      `name: ${profile.name}`,
      `description: ${profile.description}`,
      `tools: ${profile.tools}`,
      `model: ${JSON.stringify(profile.model)}`,
      `maxTurns: ${profile.maxTurns}`,
      'blocking: true',
      'structured: true',
      `output: ${JSON.stringify(producerJsonSchema(profile.output))}`,
      '---',
      '',
      profileBody(profile, inputs),
      '',
    ].join('\n'),
  )
  recorder.wrote(destination)
}

function copyIssueTriageSlice(distDirectory: string, recorder: OutputRecorder, inputs: Set<string>): void {
  const missing = issueTriageSlice.filter((path) => !existsSync(join(issueTriageSource, path)))
  if (missing.length > 0) throw new Error(`issue-triage runtime slice missing source: ${missing.join(', ')}`)
  for (const path of issueTriageSlice) {
    const source = join(issueTriageSource, path)
    const destination = join(distDirectory, 'issue-triage', path)
    recorder.claim(destination)
    mkdirSync(dirname(destination), { recursive: true })
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

async function buildOmpBuildContracts(outputRoot: string): Promise<BuildReport> {
  requirePinnedBun()
  const root = resolve(outputRoot)
  if (root !== pluginRoot && existsSync(root)) throw new Error(`temporary output root already exists: ${root}`)
  const agentDirectory = join(root, 'agents')
  const distDirectory = join(root, 'dist')
  const inputs = new Set<string>()
  mkdirSync(agentDirectory, { recursive: true })
  mkdirSync(distDirectory, { recursive: true })
  const recorder = outputRecorder(root)
  copyAgentSources(agentDirectory, recorder, inputs)
  for (const profile of nativeReviewProfiles) writeProfile(agentDirectory, profile, recorder, inputs)
  for (const profile of nativeFeatureProfiles) writeProfile(agentDirectory, profile, recorder, inputs)
  copyIssueTriageSlice(distDirectory, recorder, inputs)
  const entrypoint = join(pluginRoot, 'contracts.ts')
  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir: distDirectory,
    target: 'node',
    format: 'esm',
    metafile: true,
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    throw new Error('omp-build contracts bundle failed')
  }
  for (const output of result.outputs) {
    recorder.claim(output.path)
    recorder.wrote(output.path)
  }
  const declaration = join(distDirectory, 'contracts.d.ts')
  recorder.claim(declaration)
  writeFileSync(declaration, "export * from '../contracts.ts'\n")
  recorder.wrote(declaration)
  for (const path of inputsOf(result.metafile, entrypoint)) inputs.add(path)
  return { outputs: recorder.paths(), inputs: [...inputs].sort() }
}

console.log(JSON.stringify(await buildOmpBuildContracts(outputRootFromArgs(process.argv.slice(2)))))
