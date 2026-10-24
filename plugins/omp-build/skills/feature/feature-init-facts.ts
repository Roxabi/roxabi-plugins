import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { landingHidesChecks, semctxHooks } from './feature-init-hooks'
import { IssueTriageMissing, type MigrateLabel, resolveMigrateLabel } from './feature-init-triage'
import type { Facts, LabelsState, ParseYaml } from './feature-init-types'
import { detectsVitest } from './feature-init-workspaces'
import { bunYamlParse } from './feature-init-yaml'

const HOOK_LINES: Record<'present' | 'absent' | 'unreadable' | 'extends', string | null> = {
  present: null,
  absent: 'semctx hooks',
  unreadable: 'semctx hooks unknown (lefthook.yml unreadable)',
  extends: 'semctx hooks unknown (extends)',
}

function knownHookState(hooks: Facts['hooks']): hooks is keyof typeof HOOK_LINES {
  return Object.hasOwn(HOOK_LINES, hooks)
}

function labelPlan(facts: Facts): string[] {
  switch (facts.labelsState) {
    case 'gh-failed':
      return ['labels unknown (gh failed)']
    case 'no-origin':
      return ['labels unknown (no GitHub origin)']
    case 'non-github':
      return ['labels unknown (non-GitHub origin)']
    case 'ok':
      if (facts.legacyLabels.length) return ['label migration']
      return facts.hasTracker ? [] : ['labels']
  }
}

function trackerPlan(facts: Facts): string[] {
  return [...(facts.hasTracker ? [] : ['tracker contract']), ...labelPlan(facts)]
}

function semctxPlan(facts: Facts): string[] {
  const lines: string[] = []
  if (facts.hasSemctx) {
    const hookLine = knownHookState(facts.hooks) ? HOOK_LINES[facts.hooks] : `semctx hooks unknown (${facts.hooks})`
    if (hookLine) lines.push(hookLine)
    if (!facts.hasWorkingEmptyJob) lines.push('CI job semctx-working-empty')
  }
  if (facts.activeContracts > 0) lines.push(`${facts.activeContracts} active semctx contracts`)
  return lines
}

function toolPlan(facts: Facts): string[] {
  const lines: string[] = []
  if (!facts.hasAssertledger) lines.push(facts.vitest ? 'assertledger + vitest adapter' : 'assertledger')
  if (!facts.hasCcc && !facts.cccConsent) lines.push('ccc proposed')
  if (!facts.hasCodegraph && !facts.codegraphConsent) lines.push('codegraph proposed')
  return lines
}

function landingPlan(facts: Facts): string[] {
  if (facts.hasLanding) {
    return [
      facts.landingHidesChecks
        ? 'landing kept (existing; required_checks hides other checks)'
        : 'landing kept (existing)',
    ]
  }
  if (!facts.mergeOnGreen) return []
  const gates = facts.gates.length ? facts.gates.join(' ; ') : 'unknown'
  return [`landing = merge-on-green (every check; gates: ${gates})`]
}

function releasePlan(facts: Facts): string[] {
  const lines: string[] = []
  if (!facts.hasWorktree) lines.push('worktree block')
  if (!facts.hasPostMerge) lines.push('release.post_merge asked')
  if (!facts.hasReleaseModel) lines.push('release.model asked')
  return lines
}

export function plan(facts: Facts): string[] {
  return [...trackerPlan(facts), ...semctxPlan(facts), ...toolPlan(facts), ...landingPlan(facts), ...releasePlan(facts)]
}

/** Runs `gh` in the target repo; returns stdout, or null when gh cannot answer. */
export type Gh = (args: string[]) => string | null

export type GitRemoteUrl = (remote: string) => string | null

export function realGh(dir: string): Gh {
  return (args) => {
    try {
      return execFileSync('gh', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      return null
    }
  }
}

export function realGitRemoteUrl(dir: string): GitRemoteUrl {
  return (remote) => {
    try {
      return execFileSync('git', ['remote', 'get-url', remote], {
        cwd: dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
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

/**
 * The `gh -R` value for a git remote: `owner/repo` when the remote is on
 * github.com, else null. Any other host (GHE, GitLab, an ssh alias, an IP,
 * `github.com.`), a local or `file://` remote, or a path that is not exactly
 * `owner/repo` is refused: gh would send its enterprise token to that host.
 */
export function ownerRepoFromRemote(url: string | null): string | null {
  const text = url?.trim()
  if (!text) return null
  let host: string
  let repoPath: string
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    let parsed: URL
    try {
      parsed = new URL(text)
    } catch {
      return null
    }
    if (!['ssh:', 'https:', 'http:', 'git:'].includes(parsed.protocol)) return null
    host = parsed.hostname
    repoPath = parsed.pathname
  } else {
    const scp = /^(?:[^@/\s]+@)?([^:/\s]+):([^/].*)$/.exec(text)
    if (!scp?.[1] || !scp[2]) return null
    host = scp[1]
    repoPath = scp[2]
  }
  const parts = repoPath
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/, '')
    .split('/')
  if (!host || parts.length !== 2 || !parts.every((part) => /^[\w.-]+$/.test(part))) return null
  return host.toLowerCase() === 'github.com' ? parts.join('/') : null
}

/** The regex literals the merge-on-green gate tests check-run names with. Unparseable ones are skipped. */
export function gateRegexes(workflow: string): RegExp[] {
  const out: RegExp[] = []
  for (const match of workflow.matchAll(/\.some\(\(r\)\s*=>\s*\/((?:\\.|[^/\n])+)\/([a-z]*)\.test\(r\.name/g)) {
    try {
      out.push(new RegExp(match[1] ?? '', match[2]))
    } catch {}
  }
  return out
}

/** Diagnostic gate labels: each gate regex source with leading ^ / trailing $ stripped. */
export function gateNames(workflow: string): string[] {
  return gateRegexes(workflow).map((re) => re.source.replace(/^\^/, '').replace(/\$$/, ''))
}
export type ReadFactsOpts = {
  gh?: Gh
  gitRemoteUrl?: GitRemoteUrl
  migrateLabel?: MigrateLabel
  parseYaml?: ParseYaml
}

type FactInputs = {
  migrate: MigrateLabel
  gh: Gh
  gitRemoteUrl: GitRemoteUrl
  parseYaml: ParseYaml
}

type FactSources = { stack: string; merge: string; ci: string; pkg: string }
type LabelFacts = { labels: string[]; state: LabelsState }

async function factInputs(dir: string, opts: ReadFactsOpts): Promise<FactInputs> {
  const migrate = opts.migrateLabel !== undefined ? opts.migrateLabel : await resolveMigrateLabel()
  if (typeof migrate !== 'function') throw new IssueTriageMissing('migrateLabel is not a function')
  return {
    migrate,
    gh: opts.gh ?? realGh(dir),
    gitRemoteUrl: opts.gitRemoteUrl ?? realGitRemoteUrl(dir),
    parseYaml: opts.parseYaml ?? bunYamlParse,
  }
}

function factSources(dir: string): FactSources {
  return {
    stack: read(join(dir, '.dev', 'stack.yml')),
    merge: read(join(dir, '.github', 'workflows', 'merge-on-green.yml')),
    ci: read(join(dir, '.github', 'workflows', 'ci.yml')),
    pkg: read(join(dir, 'package.json')),
  }
}

function labelState(origin: string | null, repo: string | null, labels: string[] | null): LabelsState {
  if (!origin?.trim()) return 'no-origin'
  if (!repo) return 'non-github'
  if (labels === null) return 'gh-failed'
  return 'ok'
}

function labelFacts(origin: string | null, gh: Gh): LabelFacts {
  const repo = ownerRepoFromRemote(origin)
  const listed = repo
    ? lines(gh(['label', 'list', '-R', `github.com/${repo}`, '--limit', '500', '--json', 'name', '--jq', '.[].name']))
    : null
  return { labels: listed ?? [], state: labelState(origin, repo, listed) }
}

export async function readFacts(dir: string, opts: ReadFactsOpts = {}): Promise<Facts> {
  const inputs = await factInputs(dir, opts)
  const sources = factSources(dir)
  const labels = labelFacts(inputs.gitRemoteUrl('origin'), inputs.gh)
  const hasLanding = /^landing:/m.test(sources.stack)
  return {
    hasTracker: existsSync(join(dir, 'docs', 'agents', 'issue-tracker.md')),
    labels: labels.labels,
    labelsState: labels.state,
    legacyLabels: labels.labels.filter((label) => inputs.migrate(label).remove),
    hasSemctx: existsSync(join(dir, '.semctx')),
    hooks: semctxHooks(dir, inputs.parseYaml),
    hasWorkingEmptyJob: /^\s*(name:\s*)?semctx-working-empty:?\s*$/m.test(sources.ci),
    activeContracts: countActiveContracts(dir),
    hasAssertledger: /"assertledger"/.test(sources.pkg),
    vitest: detectsVitest(dir),
    hasCcc: existsSync(join(dir, '.cocoindex_code')),
    hasCodegraph: existsSync(join(dir, '.codegraph')),
    mergeOnGreen: Boolean(sources.merge),
    hasLanding,
    landingHidesChecks: hasLanding && landingHidesChecks(sources.stack, Boolean(sources.merge), inputs.parseYaml),
    gates: sources.merge ? gateNames(sources.merge) : [],
    hasWorktree: /^worktree:/m.test(sources.stack),
    hasPostMerge: /post_merge/.test(sources.stack),
    hasReleaseModel: /^ {2}model:/m.test(sources.stack),
    cccConsent: /ccc:\s*true/.test(sources.stack),
    codegraphConsent: /codegraph:\s*true/.test(sources.stack),
  }
}
