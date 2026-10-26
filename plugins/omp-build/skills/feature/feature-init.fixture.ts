import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll } from 'vitest'
import { migrateLabel } from '../../../issue-triage/skills/issue-triage/lib/migrate-labels'
import { FIXTURE_NAMES, stageFixture } from './__fixtures__/feature-init/stage'
import { readFacts } from './feature-init-facts'
import type { Facts, Gh, ParseYaml } from './feature-init-types'

let staged = ''
beforeAll(() => {
  staged = mkdtempSync(path.join(tmpdir(), 'omp-init-fixtures-'))
  for (const name of FIXTURE_NAMES) stageFixture(name, path.join(staged, name))
})
afterAll(() => rmSync(staged, { recursive: true, force: true }))

let scratch: string | undefined
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true })
  scratch = undefined
})
export const fixtureRoot = () => staged

/** A fresh copy of fixture `name`, for tests that write into the target. */
export function scratchCopy(name: string): string {
  scratch = mkdtempSync(path.join(tmpdir(), `omp-init-${name}-`))
  return stageFixture(name, path.join(scratch, name))
}

export const originAcme = (remote: string) =>
  remote === 'origin'
    ? 'git@github.com:acme/app.git'
    : remote === 'upstream'
      ? 'git@github.com:acme/kit-upstream.git'
      : null

export function fixtureFile(name: string, rel: string): string {
  return readFileSync(path.join(staged, name, rel), 'utf8')
}

export function recordedArgv(name: string): string[] {
  return fixtureFile(name, 'gh/label-list.argv').trim().split('\n')
}

/** Answers only the exact recorded argv; anything else is a gh failure (null). */
export function recordedGh(name: string, body: string | null = fixtureFile(name, 'gh/labels.txt')): Gh {
  const expected = recordedArgv(name).join('\0')
  return (args) => (args.join('\0') === expected ? body : null)
}

/**
 * Vitest has no Bun.YAML: answer with the Bun-parsed snapshot of the fixture's
 * lefthook.yml. The integration suite proves each snapshot equals Bun.YAML.parse.
 */
export function recordedParseYaml(name: string): ParseYaml {
  const answers = new Map<string, unknown>([
    [fixtureFile(name, 'lefthook.yml'), JSON.parse(fixtureFile(name, 'lefthook.parsed.json'))],
    [fixtureFile(name, '.dev/stack.yml'), JSON.parse(fixtureFile(name, 'stack.parsed.json'))],
  ])
  return (input) => {
    if (!answers.has(input)) throw new Error(`unexpected YAML input for fixture ${name}`)
    return answers.get(input)
  }
}

export function factsIn(dir: string, name: string, gh: Gh = recordedGh(name)) {
  return readFacts(dir, { gh, gitRemoteUrl: originAcme, migrateLabel, parseYaml: recordedParseYaml(name) })
}

export function factsFor(name: string, gh?: Gh) {
  return factsIn(path.join(staged, name), name, gh)
}

export function baseFacts(): Facts {
  return {
    hasTracker: true,
    labels: [],
    labelsState: 'ok',
    legacyLabels: [],
    hasCcc: true,
    hasCodegraph: true,
    mergeOnGreen: true,
    hasLanding: false,
    landingHidesChecks: false,
    gates: [],
    hasWorktree: true,
    hasPostMerge: true,
    hasReleaseModel: true,
    cccConsent: false,
    codegraphConsent: false,
  }
}
