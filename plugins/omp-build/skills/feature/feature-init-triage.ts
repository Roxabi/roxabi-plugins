import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import type { InitDeps, InitPlan } from '../../dist/issue-triage/skills/issue-triage/lib/init.ts'
import { initFile, migrateLabelsFile } from '../../triage-runtime.ts'

export type MigrateLabel = (name: string) => { add: string | null; remove: boolean }

export class IssueTriageMissing extends Error {
  constructor(detail?: string) {
    super(detail ? `issue-triage missing (${detail})` : 'issue-triage missing')
    this.name = 'IssueTriageMissing'
  }
}

/** Imports the installed emit. An import error is final: no later candidate is tried. */
export async function loadMigrateLabel(): Promise<MigrateLabel> {
  const file = migrateLabelsFile
  if (!existsSync(file)) throw new IssueTriageMissing('not found next to omp-build or in node_modules')
  let mod: { migrateLabel?: unknown }
  try {
    mod = await import(pathToFileURL(file).href)
  } catch (err) {
    throw new IssueTriageMissing(`${file}: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (typeof mod.migrateLabel !== 'function') throw new IssueTriageMissing(`${file}: no migrateLabel export`)
  return mod.migrateLabel as MigrateLabel
}

export async function resolveMigrateLabel(
  loader: () => Promise<MigrateLabel> = loadMigrateLabel,
): Promise<MigrateLabel> {
  const fn = await loader()
  if (typeof fn !== 'function') throw new IssueTriageMissing('migrateLabel is not a function')
  return fn
}

export type TriageInit = {
  buildPlan: (
    repo: string,
    cwdRepo: string,
    deps: Pick<InitDeps, 'listLabelNames' | 'listIssueLabelSets' | 'readContract'>,
  ) => Promise<{ plan: InitPlan; issues: unknown[]; contractText: string }>
  canonicalPlan: (plan: InitPlan, contractText: string) => string
  applyApprovedPlan: (plan: InitPlan, contractText: string, deps: InitDeps) => Promise<InitPlan>
  defaultInitDeps: (cwdRepo: string, cwd?: string) => InitDeps
}

/** Loads the installed tracker planner. An import error is final. */
export async function loadTriageInit(): Promise<TriageInit> {
  const file = initFile
  if (!existsSync(file)) throw new IssueTriageMissing('init planner not found next to omp-build or in node_modules')
  let mod: Partial<TriageInit>
  try {
    mod = await import(pathToFileURL(file).href)
  } catch (err) {
    throw new IssueTriageMissing(`${file}: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (
    typeof mod.buildPlan !== 'function' ||
    typeof mod.canonicalPlan !== 'function' ||
    typeof mod.applyApprovedPlan !== 'function' ||
    typeof mod.defaultInitDeps !== 'function'
  ) {
    throw new IssueTriageMissing(`${file}: missing tracker approval exports`)
  }
  return mod as TriageInit
}
