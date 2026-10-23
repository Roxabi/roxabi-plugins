#!/usr/bin/env bun

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { producerJsonSchema } from '../plugins/omp-build/engine/core.ts'
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

const pluginDirectory = 'plugins/omp-build'
const outputDirectory = `${pluginDirectory}/dist`
const agentDirectory = `${pluginDirectory}/agents`
const issueTriageSource = 'plugins/issue-triage'
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

function copyIssueTriageSlice(): void {
  const missing = issueTriageSlice.filter((relative) => !existsSync(join(issueTriageSource, relative)))
  if (missing.length > 0) {
    throw new Error(`issue-triage runtime slice missing source: ${missing.join(', ')}`)
  }
  const destRoot = join(outputDirectory, 'issue-triage')
  rmSync(destRoot, { recursive: true, force: true })
  for (const relative of issueTriageSlice) {
    const dest = join(destRoot, relative)
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(join(issueTriageSource, relative), dest)
  }
}

function bodyOf(path: string): string {
  const source = readFileSync(path, 'utf8')
  const end = source.indexOf('\n---\n', 4)
  if (!source.startsWith('---\n') || end === -1) throw new Error(`agent profile ${path} has no frontmatter`)
  return source.slice(end + 5).trim()
}

function profileBody(profile: GeneratedProfile): string {
  const body = profile.sourceAgent !== undefined ? bodyOf(`${pluginDirectory}/${profile.sourceAgent}`) : profile.body
  if (body === undefined) throw new Error(`native profile ${profile.name} has no body source`)
  return profile.instructions === undefined ? body : `${body}\n\n${profile.instructions}`
}

function writeProfile(profile: GeneratedProfile): void {
  const output = JSON.stringify(producerJsonSchema(profile.output))
  writeFileSync(
    `${agentDirectory}/${profile.name}.md`,
    [
      '---',
      `name: ${profile.name}`,
      `description: ${profile.description}`,
      `tools: ${profile.tools}`,
      `model: ${JSON.stringify(profile.model)}`,
      `maxTurns: ${profile.maxTurns}`,
      'blocking: true',
      'structured: true',
      `output: ${output}`,
      '---',
      '',
      profileBody(profile),
      '',
    ].join('\n'),
  )
}

mkdirSync(agentDirectory, { recursive: true })
for (const profile of nativeReviewProfiles) writeProfile(profile)
for (const profile of nativeFeatureProfiles) writeProfile(profile)
mkdirSync(outputDirectory, { recursive: true })
copyIssueTriageSlice()

const result = await Bun.build({
  entrypoints: ['plugins/omp-build/contracts.ts'],
  outdir: outputDirectory,
  target: 'node',
  format: 'esm',
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exitCode = 1
} else {
  writeFileSync(`${outputDirectory}/contracts.d.ts`, "export * from '../contracts.ts'\n")
}
