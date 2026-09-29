#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

type MigrateLabel = (name: string) => { add: string | null; remove: boolean }

/**
 * issue-triage's migration grammar, loaded at run time. Installed plugins are
 * siblings under `~/.omp/plugins/node_modules`, so the package name resolves
 * there; in this repository the plugins are siblings under `plugins/`.
 */
async function loadMigrateLabel(): Promise<MigrateLabel> {
  const rel = 'skills/issue-triage/lib/migrate-labels.ts'
  try {
    return (await import(`issue-triage/${rel}`)).migrateLabel
  } catch {
    return (await import(new URL(`../../../issue-triage/${rel}`, import.meta.url).href)).migrateLabel
  }
}

export const migrateLabel: MigrateLabel = await loadMigrateLabel()

export type Facts = {
  hasTracker: boolean
  labels: string[]
  legacyLabels: string[]
  hasSemctx: boolean
  hasSemctxHooks: boolean
  hasWorkingEmptyJob: boolean
  activeContracts: number
  hasAssertledger: boolean
  vitest: boolean
  hasCcc: boolean
  hasCodegraph: boolean
  mergeOnGreen: boolean
  checks: string[]
  hasWorktree: boolean
  hasPostMerge: boolean
  hasReleaseModel: boolean
  cccConsent: boolean
  codegraphConsent: boolean
}

export function plan(facts: Facts): string[] {
  const lines: string[] = []
  if (!facts.hasTracker) lines.push('tracker contract')
  if (facts.legacyLabels.length) lines.push('label migration')
  else if (!facts.hasTracker) lines.push('labels')
  if (facts.hasSemctx && !facts.hasSemctxHooks) lines.push('semctx hooks')
  if (facts.hasSemctx && !facts.hasWorkingEmptyJob) lines.push('CI job semctx-working-empty')
  if (facts.activeContracts > 0) lines.push(`${facts.activeContracts} orphan contracts`)
  if (!facts.hasAssertledger) {
    lines.push(facts.vitest ? 'assertledger + vitest adapter' : 'assertledger')
  }
  if (!facts.hasCcc && !facts.cccConsent) lines.push('ccc proposed')
  if (!facts.hasCodegraph && !facts.codegraphConsent) lines.push('codegraph proposed')
  if (facts.mergeOnGreen) {
    const checks = facts.checks.length ? facts.checks.join(' + ') : 'every check'
    lines.push(`landing = merge-on-green with ${checks}`)
  }
  if (!facts.hasWorktree) lines.push('worktree block')
  if (!facts.hasPostMerge) lines.push('release.post_merge asked')
  if (!facts.hasReleaseModel) lines.push('release.model asked')
  return lines
}

/** Runs `gh` in the target repo; returns stdout, or null when gh cannot answer. */
export type Gh = (args: string[]) => string | null

export function realGh(dir: string): Gh {
  return (args) => {
    try {
      return execFileSync('gh', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      return null
    }
  }
}

function lines(text: string | null): string[] | null {
  if (text === null) return null
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

/** The regex literals the merge-on-green gate tests check-run names with. */
export function gateRegexes(workflow: string): RegExp[] {
  const out: RegExp[] = []
  for (const match of workflow.matchAll(/\.some\(\(r\)\s*=>\s*\/((?:\\.|[^/\n])+)\/([a-z]*)\.test\(r\.name/g)) {
    out.push(new RegExp(match[1] ?? '', match[2]))
  }
  return out
}

/**
 * Required checks = the real check-run names on the head of the last merged PR
 * that satisfy each gate. Any gate without a matching real name, or no answer
 * from GitHub, yields [] — which means watch every check.
 */
export function requiredChecks(workflow: string, runNames: string[] | null): string[] {
  const gates = gateRegexes(workflow)
  if (!gates.length || !runNames?.length) return []
  const names = [...new Set(runNames)]
  const picked: string[] = []
  for (const gate of gates) {
    const hits = names.filter((name) => gate.test(name))
    if (!hits.length) return []
    for (const hit of hits) if (!picked.includes(hit)) picked.push(hit)
  }
  return picked
}

function mergedHeadRuns(gh: Gh): string[] | null {
  const head = lines(
    gh(['pr', 'list', '--state', 'merged', '--limit', '1', '--json', 'headRefOid', '--jq', '.[0].headRefOid']),
  )?.[0]
  if (!head || !/^[0-9a-f]{40}$/.test(head)) return null
  return lines(
    gh(['api', `repos/{owner}/{repo}/commits/${head}/check-runs`, '--paginate', '--jq', '.check_runs[].name']),
  )
}

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

function countActiveContracts(dir: string): number {
  const root = join(dir, '.semctx', 'semantic', 'changes')
  if (!existsSync(root)) return 0
  return readdirSync(root).filter(
    (name) => name.endsWith('.sem') && /^\s*status:\s*active\s*$/m.test(readFileSync(join(root, name), 'utf8')),
  ).length
}

export function readFacts(dir: string, gh: Gh = realGh(dir)): Facts {
  const stack = read(join(dir, '.dev', 'stack.yml'))
  const merge = read(join(dir, '.github', 'workflows', 'merge-on-green.yml'))
  const ci = read(join(dir, '.github', 'workflows', 'ci.yml'))
  const lefthook = read(join(dir, 'lefthook.yml'))
  const pkg = read(join(dir, 'package.json'))
  const labels = lines(gh(['label', 'list', '--limit', '500', '--json', 'name', '--jq', '.[].name'])) ?? []
  return {
    hasTracker: existsSync(join(dir, 'docs', 'agents', 'issue-tracker.md')),
    labels,
    legacyLabels: labels.filter((label) => migrateLabel(label).remove),
    hasSemctx: existsSync(join(dir, '.semctx')),
    hasSemctxHooks: /^\s*run:.*\bsemctx/m.test(lefthook),
    hasWorkingEmptyJob: /^\s*(name:\s*)?semctx-working-empty:?\s*$/m.test(ci),
    activeContracts: countActiveContracts(dir),
    hasAssertledger: /"assertledger"/.test(pkg),
    vitest: /"vitest"/.test(pkg),
    hasCcc: existsSync(join(dir, '.cocoindex_code')),
    hasCodegraph: existsSync(join(dir, '.codegraph')),
    mergeOnGreen: Boolean(merge),
    checks: merge ? requiredChecks(merge, mergedHeadRuns(gh)) : [],
    hasWorktree: /^worktree:/m.test(stack),
    hasPostMerge: /post_merge/.test(stack),
    hasReleaseModel: /^ {2}model:/m.test(stack),
    cccConsent: /ccc:\s*true/.test(stack),
    codegraphConsent: /codegraph:\s*true/.test(stack),
  }
}

/** Agent-layer command. `skill://` is not resolvable in a child process. */
export const TRACKER_INIT_NEXT = 'next: bun skill://issue-triage/triage.ts init'

export function trackerNext(dry: boolean): string {
  return dry ? `${TRACKER_INIT_NEXT} --dry-run` : TRACKER_INIT_NEXT
}

function isPrincipal(dir: string): boolean {
  const out = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: dir, encoding: 'utf8' })
  const first = out.match(/^worktree (.+)$/m)?.[1]
  if (!first) return true
  const here = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' }).trim()
  return here === first
}

function applyStack(dir: string, facts: Facts): void {
  const stackPath = join(dir, '.dev', 'stack.yml')
  let stack = existsSync(stackPath) ? readFileSync(stackPath, 'utf8') : 'schema_version: "1.0"\n'
  if (!facts.hasWorktree) {
    stack += '\nworktree:\n  copy: []\n  seed: []\n  setup: ""\n'
  }
  if (facts.mergeOnGreen && !/^landing:/m.test(stack)) {
    stack += `\nlanding:\n  mode: merge-on-green\n  required_checks: [${facts.checks.join(', ')}]\n`
  }
  writeFileSync(stackPath, stack)
}

if (import.meta.main) {
  const dir = process.argv.includes('--dir') ? process.argv[process.argv.indexOf('--dir') + 1] : process.cwd()
  const dry = process.argv.includes('--dry-run')
  if (!dry && isPrincipal(dir)) {
    console.error('init=refused principal')
    process.exit(2)
  }
  const gitDirRaw = execFileSync('git', ['rev-parse', '--git-dir'], { cwd: dir, encoding: 'utf8' }).trim()
  const gitDir = isAbsolute(gitDirRaw) ? gitDirRaw : join(dir, gitDirRaw)
  if (!dry && existsSync(join(gitDir, 'omp-build-feature-init'))) {
    console.log('init=noop')
    process.exit(0)
  }
  const facts = readFacts(dir)
  const lines = plan(facts)
  console.log(trackerNext(dry))
  if (dry) {
    for (const line of lines) console.log(line)
    process.exit(0)
  }
  applyStack(dir, facts)
  for (const line of lines) console.log(line)
}
