#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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

/** `ok`, or why the repository's labels are not known. */
export type LabelsState = 'ok' | 'gh-failed' | 'no-origin' | 'non-github'
/** Whether a lefthook git hook runs semctx, or why that cannot be told. */
export type HooksState = 'present' | 'absent' | 'unreadable' | 'extends' | `lefthook.${'toml' | 'json' | 'jsonc'}`

export type Facts = {
  hasTracker: boolean
  labels: string[]
  labelsState: LabelsState
  legacyLabels: string[]
  hasSemctx: boolean
  hooks: HooksState
  hasWorkingEmptyJob: boolean
  activeContracts: number
  hasAssertledger: boolean
  vitest: boolean
  hasCcc: boolean
  hasCodegraph: boolean
  mergeOnGreen: boolean
  hasLanding: boolean
  landingHidesChecks: boolean
  gates: string[]
  hasWorktree: boolean
  hasPostMerge: boolean
  hasReleaseModel: boolean
  cccConsent: boolean
  codegraphConsent: boolean
}

const HOOK_LINES: Record<'present' | 'absent' | 'unreadable' | 'extends', string | null> = {
  present: null,
  absent: 'semctx hooks',
  unreadable: 'semctx hooks unknown (lefthook.yml unreadable)',
  extends: 'semctx hooks unknown (extends)',
}

export function plan(facts: Facts): string[] {
  const lines: string[] = []
  if (!facts.hasTracker) lines.push('tracker contract')
  if (facts.labelsState === 'gh-failed') lines.push('labels unknown (gh failed)')
  else if (facts.labelsState === 'no-origin') lines.push('labels unknown (no GitHub origin)')
  else if (facts.labelsState === 'non-github') lines.push('labels unknown (non-GitHub origin)')
  else if (facts.legacyLabels.length) lines.push('label migration')
  else if (!facts.hasTracker) lines.push('labels')
  const hookLine = facts.hooks.startsWith('lefthook.')
    ? `semctx hooks unknown (${facts.hooks})`
    : HOOK_LINES[facts.hooks as keyof typeof HOOK_LINES]
  if (facts.hasSemctx && hookLine) lines.push(hookLine)
  if (facts.hasSemctx && !facts.hasWorkingEmptyJob) lines.push('CI job semctx-working-empty')
  if (facts.activeContracts > 0) lines.push(`${facts.activeContracts} active semctx contracts`)
  if (!facts.hasAssertledger) {
    lines.push(facts.vitest ? 'assertledger + vitest adapter' : 'assertledger')
  }
  if (!facts.hasCcc && !facts.cccConsent) lines.push('ccc proposed')
  if (!facts.hasCodegraph && !facts.codegraphConsent) lines.push('codegraph proposed')
  if (facts.hasLanding) {
    lines.push(
      facts.landingHidesChecks
        ? 'landing kept (existing; required_checks hides other checks)'
        : 'landing kept (existing)',
    )
  } else if (facts.mergeOnGreen) {
    const gates = facts.gates.length ? facts.gates.join(' ; ') : 'unknown'
    lines.push(`landing = merge-on-green (every check; gates: ${gates})`)
  }
  if (!facts.hasWorktree) lines.push('worktree block')
  if (!facts.hasPostMerge) lines.push('release.post_merge asked')
  if (!facts.hasReleaseModel) lines.push('release.model asked')
  return lines
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

/** Lefthook groups that wrap real git hooks. Manual groups such as `pr:` are excluded. */
export const GIT_HOOK_GROUPS = new Set([
  'applypatch-msg',
  'pre-applypatch',
  'post-applypatch',
  'pre-commit',
  'pre-merge-commit',
  'prepare-commit-msg',
  'commit-msg',
  'post-commit',
  'pre-rebase',
  'post-rewrite',
  'post-checkout',
  'post-merge',
  'pre-push',
  'pre-auto-gc',
])

/** lefthook's main config names, in lookup order, then the local override names. */
export const LEFTHOOK_MAIN = [
  'lefthook.yml',
  '.lefthook.yml',
  'lefthook.yaml',
  '.lefthook.yaml',
  '.config/lefthook.yml',
  '.config/lefthook.yaml',
]
export const LEFTHOOK_LOCAL = [
  'lefthook-local.yml',
  '.lefthook-local.yml',
  'lefthook-local.yaml',
  '.lefthook-local.yaml',
  '.config/lefthook-local.yml',
  '.config/lefthook-local.yaml',
]

/** lefthook config formats this reader does not parse. */
export const LEFTHOOK_FOREIGN = ['toml', 'json', 'jsonc'] as const

export type ParseYaml = (text: string) => unknown

export function bunYamlParse(text: string): unknown {
  if (typeof Bun === 'undefined' || typeof Bun.YAML?.parse !== 'function') {
    throw new Error('reading YAML needs bun >= 1.2.21 (Bun.YAML)')
  }
  return Bun.YAML.parse(text)
}

type YamlMap = Record<string, unknown>

function isMap(value: unknown): value is YamlMap {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** lefthook's local-override merge: maps merge key by key, anything else is replaced. */
function mergeConfig(base: unknown, local: unknown): unknown {
  if (!isMap(base) || !isMap(local)) return local
  const out: YamlMap = { ...base }
  for (const [key, value] of Object.entries(local)) out[key] = mergeConfig(base[key], value)
  return out
}

const SEMCTX = /\bsemctx\b/

function skipped(value: unknown): boolean {
  return isMap(value) && value.skip === true
}

function jobsRunSemctx(jobs: unknown): boolean {
  if (!Array.isArray(jobs)) return false
  return jobs.some((job) => {
    if (!isMap(job) || skipped(job)) return false
    if (['name', 'run', 'script'].some((key) => typeof job[key] === 'string' && SEMCTX.test(job[key] as string))) {
      return true
    }
    return isMap(job.group) && !skipped(job.group) && jobsRunSemctx(job.group.jobs)
  })
}

/**
 * True when a lefthook *git-hook* group runs semctx: a command key or its `run`,
 * a `scripts` key, or a job (`name`, `run`, `script`, nested `group.jobs`).
 * `skip: true` on the group, command, script or job removes it. Manual groups
 * such as `pr:` do not count — lefthook does not install them as git hooks.
 */
export function hasSemctxGitHooks(doc: unknown): boolean {
  if (!isMap(doc)) return false
  for (const [group, body] of Object.entries(doc)) {
    if (!GIT_HOOK_GROUPS.has(group) || !isMap(body) || skipped(body)) continue
    const commands = isMap(body.commands) ? Object.entries(body.commands) : []
    const scripts = isMap(body.scripts) ? Object.entries(body.scripts) : []
    if (
      commands.some(
        ([key, cmd]) =>
          !skipped(cmd) && (SEMCTX.test(key) || (isMap(cmd) && typeof cmd.run === 'string' && SEMCTX.test(cmd.run))),
      ) ||
      scripts.some(([key, script]) => !skipped(script) && SEMCTX.test(key)) ||
      jobsRunSemctx(body.jobs)
    ) {
      return true
    }
  }
  return false
}

/**
 * The semctx hook fact from the first main lefthook config and the first local
 * override. A config that cannot be parsed, or is not a map, is `unreadable`; a
 * TOML or JSON config, which is not read here, is reported by its extension. When nothing local
 * runs semctx but the config pulls in `extends`/`remotes`, the answer is
 * `extends`: those files are not read here.
 */
export function semctxHooks(dir: string, parseYaml: ParseYaml): HooksState {
  const pick = (names: string[]) => names.map((name) => join(dir, name)).find((file) => existsSync(file))
  const main = pick(LEFTHOOK_MAIN)
  if (!main) {
    const foreign = LEFTHOOK_FOREIGN.find((ext) =>
      [`lefthook.${ext}`, `.lefthook.${ext}`, `.config/lefthook.${ext}`].some((name) => existsSync(join(dir, name))),
    )
    if (foreign) return `lefthook.${foreign}`
  }
  const files = [main, pick(LEFTHOOK_LOCAL)].filter((file): file is string => Boolean(file))
  let doc: unknown = {}
  for (const file of files) {
    let parsed: unknown
    try {
      parsed = parseYaml(readFileSync(file, 'utf8')) ?? {}
    } catch {
      return 'unreadable'
    }
    if (!isMap(parsed)) return 'unreadable'
    doc = mergeConfig(doc, parsed)
  }
  if (hasSemctxGitHooks(doc)) return 'present'
  if (isMap(doc) && (doc.extends != null || doc.remotes != null)) return 'extends'
  return 'absent'
}

/** True when an existing merge-on-green landing declares a non-empty `required_checks`. */
function landingHidesChecks(stack: string, mergeOnGreenWorkflow: boolean, parseYaml: ParseYaml): boolean {
  let doc: unknown
  try {
    doc = parseYaml(stack)
  } catch {
    return false
  }
  const landing = isMap(doc) ? doc.landing : null
  if (!isMap(landing)) return false
  const mode = landing.mode ?? (mergeOnGreenWorkflow ? 'merge-on-green' : 'native')
  return mode === 'merge-on-green' && Array.isArray(landing.required_checks) && landing.required_checks.length > 0
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

const DEPENDENCY_MAPS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']

function readPackage(dir: string): YamlMap | null {
  try {
    const doc: unknown = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    return isMap(doc) ? doc : null
  } catch {
    return null
  }
}

/** The package names a package.json declares in its dependency maps. Scripts are not dependencies. */
function dependencyNames(pkg: YamlMap | null): string[] {
  if (!pkg) return []
  return DEPENDENCY_MAPS.flatMap((key) => {
    const deps = pkg[key]
    return isMap(deps) ? Object.keys(deps) : []
  })
}

/** One `workspaces` glob as an anchored regex over `/`-joined relative paths. */
function workspaceGlob(glob: string): RegExp {
  const parts = glob.replace(/^\.\//, '').replace(/\/+$/, '').split('/')
  let source = ''
  parts.forEach((part, index) => {
    const last = index === parts.length - 1
    if (part === '**') source += last ? '(?:[^/]+(?:/[^/]+){0,2})?' : '(?:[^/]+/){0,3}'
    else source += part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + (last ? '' : '/')
  })
  return new RegExp(`^${source}$`)
}

/** Bounded expansion of npm/bun `workspaces` globs: `*` is one level, `**` up to three, `!` excludes. */
export function workspaceDirs(dir: string, pkg: YamlMap | null): string[] {
  const field = pkg?.workspaces
  const globs = Array.isArray(field) ? field : isMap(field) && Array.isArray(field.packages) ? field.packages : []
  const patterns = globs.filter((glob): glob is string => typeof glob === 'string')
  const include = patterns.filter((glob) => !glob.startsWith('!')).map(workspaceGlob)
  const exclude = patterns.filter((glob) => glob.startsWith('!')).map((glob) => workspaceGlob(glob.slice(1)))
  if (!include.length) return []
  const out: string[] = []
  const walk = (rel: string, depth: number) => {
    if (out.length >= 500 || depth > 4) return
    let entries: string[]
    try {
      entries = readdirSync(join(dir, rel), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.'))
        .map((entry) => entry.name)
    } catch {
      return
    }
    for (const name of entries) {
      const child = rel ? `${rel}/${name}` : name
      if (include.some((re) => re.test(child)) && !exclude.some((re) => re.test(child))) {
        if (existsSync(join(dir, child, 'package.json'))) out.push(join(dir, child))
      }
      walk(child, depth + 1)
    }
  }
  walk('', 0)
  return out
}

const VITEST_CONFIG = /^vitest\.(?:config|workspace)\.[a-z]+$/

/**
 * True when the repository uses vitest: a `vitest` or `@vitest/*` dependency,
 * or a `vitest.config.*` / `vitest.workspace.*` file, at the root or in a
 * `workspaces` package. A script that merely mentions vitest does not count.
 */
export function detectsVitest(dir: string): boolean {
  const root = readPackage(dir)
  for (const pkgDir of [dir, ...workspaceDirs(dir, root)]) {
    const pkg = pkgDir === dir ? root : readPackage(pkgDir)
    if (dependencyNames(pkg).some((name) => name === 'vitest' || name.startsWith('@vitest/'))) return true
    try {
      if (readdirSync(pkgDir).some((name) => VITEST_CONFIG.test(name))) return true
    } catch {}
  }
  return false
}

export type ReadFactsOpts = {
  gh?: Gh
  gitRemoteUrl?: GitRemoteUrl
  migrateLabel?: MigrateLabel
  parseYaml?: ParseYaml
}

export async function readFacts(dir: string, opts: ReadFactsOpts = {}): Promise<Facts> {
  const migrate = opts.migrateLabel !== undefined ? opts.migrateLabel : await resolveMigrateLabel()
  if (typeof migrate !== 'function') throw new IssueTriageMissing('migrateLabel is not a function')

  const gh = opts.gh ?? realGh(dir)
  const gitRemoteUrl = opts.gitRemoteUrl ?? realGitRemoteUrl(dir)
  const parseYaml = opts.parseYaml ?? bunYamlParse
  const stack = read(join(dir, '.dev', 'stack.yml'))
  const merge = read(join(dir, '.github', 'workflows', 'merge-on-green.yml'))
  const ci = read(join(dir, '.github', 'workflows', 'ci.yml'))
  const pkg = read(join(dir, 'package.json'))
  const hasLanding = /^landing:/m.test(stack)

  const origin = gitRemoteUrl('origin')
  const repo = ownerRepoFromRemote(origin)
  const labelLines = repo
    ? lines(gh(['label', 'list', '-R', `github.com/${repo}`, '--limit', '500', '--json', 'name', '--jq', '.[].name']))
    : null
  const labelsState: LabelsState = !origin?.trim()
    ? 'no-origin'
    : !repo
      ? 'non-github'
      : labelLines === null
        ? 'gh-failed'
        : 'ok'
  const labels = labelLines ?? []

  return {
    hasTracker: existsSync(join(dir, 'docs', 'agents', 'issue-tracker.md')),
    labels,
    labelsState,
    legacyLabels: labels.filter((label) => migrate(label).remove),
    hasSemctx: existsSync(join(dir, '.semctx')),
    hooks: semctxHooks(dir, parseYaml),
    hasWorkingEmptyJob: /^\s*(name:\s*)?semctx-working-empty:?\s*$/m.test(ci),
    activeContracts: countActiveContracts(dir),
    hasAssertledger: /"assertledger"/.test(pkg),
    vitest: detectsVitest(dir),
    hasCcc: existsSync(join(dir, '.cocoindex_code')),
    hasCodegraph: existsSync(join(dir, '.codegraph')),
    mergeOnGreen: Boolean(merge),
    hasLanding,
    landingHidesChecks: hasLanding && landingHidesChecks(stack, Boolean(merge), parseYaml),
    gates: merge ? gateNames(merge) : [],
    hasWorktree: /^worktree:/m.test(stack),
    hasPostMerge: /post_merge/.test(stack),
    hasReleaseModel: /^ {2}model:/m.test(stack),
    cccConsent: /ccc:\s*true/.test(stack),
    codegraphConsent: /codegraph:\s*true/.test(stack),
  }
}

function isPrincipal(dir: string): boolean {
  const out = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: dir, encoding: 'utf8' })
  const first = out.match(/^worktree (.+)$/m)?.[1]
  if (!first) return true
  const here = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' }).trim()
  // Match scripts/check-principal-branch.sh: compare physical paths, not symlink spellings.
  try {
    return realpathSync(here) === realpathSync(first)
  } catch {
    return here === first
  }
}

export type StackAddition = { key: 'commands.test' | 'worktree' | 'landing'; text: string; source: string }
export type StackProposal = {
  additions: StackAddition[]
  conflicts: string[]
  refusal: string | null
  before: string | null
  after: string | null
}

function hasOwn(map: YamlMap, key: string): boolean {
  return Object.hasOwn(map, key)
}

function rootMappingLines(text: string, key: string): number[] {
  return text.split('\n').flatMap((line, index) => (new RegExp(`^${key}:\\s*(?:#.*)?$`).test(line) ? [index] : []))
}

export type CommandEvidence = { command: string; source: string }

function packageRunner(dir: string, pkg: YamlMap | null): string | null {
  const declared = typeof pkg?.packageManager === 'string' ? pkg.packageManager.split('@')[0] : null
  if (declared === 'npm' || declared === 'pnpm' || declared === 'yarn' || declared === 'bun') return declared
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(dir, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(dir, 'package-lock.json')) || existsSync(join(dir, 'npm-shrinkwrap.json'))) return 'npm'
  if (existsSync(join(dir, 'bun.lock')) || existsSync(join(dir, 'bun.lockb'))) return 'bun'
  return null
}

/** Commands require repository evidence; manifests alone never invent flags or a runner. */
export function discoverTestCommands(dir: string): CommandEvidence[] {
  const out: CommandEvidence[] = []
  const pkg = readPackage(dir)
  const scripts = isMap(pkg?.scripts) ? pkg.scripts : null
  const runner = packageRunner(dir, pkg)
  if (runner && typeof scripts?.test === 'string' && scripts.test.trim()) {
    out.push({
      command: runner === 'npm' || runner === 'bun' ? `${runner} run test` : `${runner} test`,
      source: 'package.json scripts.test',
    })
  }
  for (const name of ['Makefile', 'makefile']) {
    const file = join(dir, name)
    if (existsSync(file) && /^test\s*:/m.test(readFileSync(file, 'utf8'))) {
      out.push({ command: 'make test', source: name })
    }
  }
  const workflows = join(dir, '.github', 'workflows')
  if (existsSync(workflows)) {
    for (const name of readdirSync(workflows)) {
      if (!/\.(?:ya?ml)$/i.test(name)) continue
      const file = join(workflows, name)
      let workingDirectory = '.'
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const workdir = line.match(/^\s*working-directory:\s*(\S.*?)\s*$/)
        if (workdir) workingDirectory = workdir[1]
        const run = line.match(/^\s*(?:-\s*)?run:\s*(\S.*?)\s*$/)
        if (
          run &&
          /(?:^|\s)(?:npm|pnpm|yarn|bun|go|cargo|pytest|make)\b/.test(run[1]) &&
          /\btest\b|pytest/.test(run[1])
        ) {
          out.push({ command: run[1], source: `.github/workflows/${name} (working-directory: ${workingDirectory})` })
        }
      }
    }
  }
  return out.filter(
    (candidate, index, all) =>
      all.findIndex((other) => other.command === candidate.command && other.source === candidate.source) === index,
  )
}

function manifestCommandUnknowns(dir: string): string[] {
  return ['pyproject.toml', 'setup.py', 'go.mod', 'Cargo.toml'].filter((name) => existsSync(join(dir, name)))
}
/** A textual, comment-preserving stack proposal. It never serializes YAML. */
export function proposeStack(dir: string, facts: Facts, parseYaml: ParseYaml = bunYamlParse): StackProposal {
  const stackPath = join(dir, '.dev', 'stack.yml')
  const before = existsSync(stackPath) ? readFileSync(stackPath, 'utf8') : null
  if (before === null) {
    const additions: StackAddition[] = []
    if (!facts.hasWorktree)
      additions.push({
        key: 'worktree',
        text: 'worktree:\n  copy: []\n  seed: []\n  setup: ""\n',
        source: '.dev/stack.yml: missing worktree',
      })
    if (facts.mergeOnGreen)
      additions.push({
        key: 'landing',
        text: 'landing:\n  mode: merge-on-green\n',
        source: '.github/workflows/merge-on-green.yml',
      })
    const after = additions.length
      ? `schema_version: "1.0"\n${additions.map((addition) => `\n${addition.text}`).join('')}`
      : null
    return { additions, conflicts: [], refusal: null, before, after }
  }
  const firstContent = before.split('\n').find((line) => line.trim() && !line.trimStart().startsWith('#')) ?? ''
  if (/^\s*[{[]/.test(firstContent) || /^\s*\.\.\.\s*$/.test(before)) {
    return {
      additions: [],
      conflicts: [],
      refusal: '.dev/stack.yml cannot be safely extended without reformatting',
      before,
      after: null,
    }
  }
  let config: unknown
  try {
    config = parseYaml(before)
  } catch {
    return { additions: [], conflicts: [], refusal: '.dev/stack.yml is unreadable', before, after: null }
  }
  if (!isMap(config)) {
    return { additions: [], conflicts: [], refusal: '.dev/stack.yml root is not a mapping', before, after: null }
  }
  const additions: StackAddition[] = []
  const conflicts: string[] = []
  const commands = config.commands
  const worktreeSetup = isMap(commands) ? commands.worktree_setup : undefined
  const testCommands = discoverTestCommands(dir)
  const distinctTestCommands = [...new Set(testCommands.map((candidate) => candidate.command))]
  if (distinctTestCommands.length === 1 && (!isMap(commands) || !hasOwn(commands, 'test'))) {
    const evidence = testCommands[0]
    if (commands !== undefined && !isMap(commands)) {
      conflicts.push('commands exists with a non-mapping value')
    } else if (commands !== undefined && rootMappingLines(before, 'commands').length !== 1) {
      return {
        additions: [],
        conflicts,
        refusal: '.dev/stack.yml commands block is not uniquely locatable',
        before,
        after: null,
      }
    } else {
      additions.push({
        key: 'commands.test',
        text:
          commands === undefined
            ? `commands:\n  test: ${JSON.stringify(evidence.command)}\n`
            : `  test: ${JSON.stringify(evidence.command)}\n`,
        source: evidence.source,
      })
    }
  } else if (distinctTestCommands.length > 1) {
    conflicts.push(`commands.test withheld: independent test commands (${distinctTestCommands.join(' ; ')})`)
  } else if (isMap(commands) && hasOwn(commands, 'test')) {
    conflicts.push('commands.test preserved')
  }
  if (distinctTestCommands.length === 0) {
    const manifests = manifestCommandUnknowns(dir)
    if (manifests.length)
      conflicts.push(`commands.test withheld: no executable test command in ${manifests.join(', ')}`)
  }
  if (!hasOwn(config, 'worktree')) {
    if (typeof worktreeSetup === 'string' && worktreeSetup.trim()) {
      conflicts.push('worktree preserved: commands.worktree_setup is declared')
    } else {
      additions.push({
        key: 'worktree',
        text: 'worktree:\n  copy: []\n  seed: []\n  setup: ""\n',
        source: '.dev/stack.yml: missing worktree',
      })
    }
  } else if (!isMap(config.worktree)) {
    conflicts.push('worktree exists with a non-mapping value')
  }
  if (facts.mergeOnGreen && !hasOwn(config, 'landing')) {
    additions.push({
      key: 'landing',
      text: 'landing:\n  mode: merge-on-green\n',
      source: '.github/workflows/merge-on-green.yml',
    })
  } else if (facts.mergeOnGreen && !isMap(config.landing)) {
    conflicts.push('landing exists with a non-mapping value')
  }
  if (['commands', 'worktree', 'landing'].some((key) => rootMappingLines(before, key).length > 1)) {
    return { additions: [], conflicts, refusal: '.dev/stack.yml has ambiguous top-level mappings', before, after: null }
  }
  let after = before
  const nested = additions.find((addition) => addition.key === 'commands.test' && commands !== undefined)
  if (nested) {
    const lines = after.split('\n')
    const start = rootMappingLines(after, 'commands')[0]
    const end = lines.findIndex((line, index) => index > start && /^[^\s]/.test(line))
    lines.splice(end === -1 ? lines.length - 1 : end, 0, nested.text.trimEnd())
    after = lines.join('\n')
  }
  const suffix = additions
    .filter((addition) => addition !== nested)
    .map((addition) => `${after.endsWith('\n') ? '\n' : '\n\n'}${addition.text}`)
    .join('')
  return { additions, conflicts, refusal: null, before, after: `${after}${suffix}` }
}

export function applyStack(dir: string, facts: Facts, parseYaml: ParseYaml = bunYamlParse): void {
  const proposal = proposeStack(dir, facts, parseYaml)
  if (proposal.refusal || proposal.after === null || proposal.before === proposal.after) return
  const stackPath = join(dir, '.dev', 'stack.yml')
  mkdirSync(dirname(stackPath), { recursive: true })
  writeFileSync(stackPath, proposal.after)
}

type FeatureArgs = { dryRun: boolean; approve?: string; operatorApproval?: string; dir?: string }

function featureArgs(args: string[]): FeatureArgs {
  const out: FeatureArgs = { dryRun: false }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--dry-run') out.dryRun = true
    else if (arg === '--approve' || arg === '--operator-approval' || arg === '--dir') {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`init: ${arg} needs a value`)
      if (arg === '--approve') out.approve = value
      else if (arg === '--operator-approval') out.operatorApproval = value
      else out.dir = value
      index++
    } else throw new Error(`init: unknown argument ${arg}`)
  }
  return out
}

type TrackerProposal = { plan: InitPlan; contractText: string; canonical: string; deps: InitDeps }
export type FeatureProposal = {
  checkout: string
  repository: string | null
  facts: Facts
  stack: StackProposal
  tracker: TrackerProposal | null
  withheld: string | null
  refusal: string | null
  digest: string
}

function hostPinned(repo: string): string {
  return repo.startsWith('github.com/') || repo.includes('://') ? repo : `github.com/${repo}`
}

function pinTrackerDeps(deps: InitDeps): InitDeps {
  return {
    ...deps,
    listLabelNames: (repo) => deps.listLabelNames(hostPinned(repo)),
    listIssueLabelSets: (repo) => deps.listIssueLabelSets(hostPinned(repo)),
    ensureLabel: (name, repo, color) => deps.ensureLabel(name, hostPinned(repo), color),
    updateLabels: (number, add, remove, repo) => deps.updateLabels(number, add, remove, hostPinned(repo)),
  }
}

async function trackerProposal(
  dir: string,
  facts: Facts,
  triage: TriageInit,
  repository: string | null = ownerRepoFromRemote(realGitRemoteUrl(dir)('origin')),
): Promise<TrackerProposal | null> {
  if (!repository || facts.labelsState !== 'ok') return null
  const deps = pinTrackerDeps(triage.defaultInitDeps(repository, dir))
  const built = await triage.buildPlan(repository, repository, deps)
  return { ...built, deps, canonical: triage.canonicalPlan(built.plan, built.contractText) }
}

function digestFor(
  checkout: string,
  repository: string | null,
  stack: StackProposal,
  tracker: TrackerProposal | null,
  withheld: string | null,
  refusal: string | null,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        checkout,
        repository,
        // Bind the bytes that apply would write, not only the addition keys.
        // Otherwise a preserved stack body can change between preview and apply
        // while additions stay identical and the digest still matches.
        before: stack.before,
        after: stack.after,
        additions: [...stack.additions].sort((left, right) => left.key.localeCompare(right.key)),
        tracker: tracker?.canonical ?? null,
        withheld,
        refusal,
      }),
    )
    .digest('hex')
}

export type FeatureInitDeps = {
  facts?: Facts
  parseYaml?: ParseYaml
  triage?: TriageInit
  repository?: string | null
  principal?: boolean
}

export async function previewFeatureInit(dir: string, deps: FeatureInitDeps = {}): Promise<FeatureProposal> {
  const checkout = realpathSync(dir)
  const facts = deps.facts ?? (await readFacts(checkout))
  const stack = proposeStack(checkout, facts, deps.parseYaml)
  const repository = deps.repository ?? ownerRepoFromRemote(realGitRemoteUrl(checkout)('origin'))
  let tracker: TrackerProposal | null = null
  let withheld: string | null = null
  let refusal = stack.refusal
  if (refusal) {
    // An unreadable stack is a hard stop; do not discover a tracker against it.
  } else if (facts.labelsState !== 'ok') withheld = `labels ${facts.labelsState}`
  else if (!repository) withheld = 'no GitHub origin'
  else {
    try {
      tracker = await trackerProposal(checkout, facts, deps.triage ?? (await loadTriageInit()), repository)
      if (tracker?.plan.refused.length) {
        refusal = tracker.plan.refused.join('\n')
        tracker = null
      }
    } catch (err) {
      withheld = err instanceof Error ? err.message : String(err)
      tracker = null
    }
  }
  return {
    checkout,
    repository,
    facts,
    stack,
    tracker,
    withheld,
    refusal,
    digest: digestFor(checkout, repository, stack, tracker, withheld, refusal),
  }
}

function trackerChanges(tracker: TrackerProposal | null): boolean {
  return Boolean(
    tracker && (tracker.plan.createLabels.length || tracker.plan.relabels.length || tracker.plan.contract === 'write'),
  )
}

function printProposal(proposal: FeatureProposal): void {
  console.log(`checkout: ${proposal.checkout}`)
  console.log(`repository: ${proposal.repository ?? 'unknown'}`)
  for (const line of plan(proposal.facts)) console.log(line)
  for (const addition of proposal.stack.additions) console.log(`stack add ${addition.key}: ${addition.source}`)
  for (const conflict of proposal.stack.conflicts) console.log(`stack conflict: ${conflict}`)
  console.log(
    `tracker: ${proposal.tracker?.canonical ?? (proposal.withheld ? `withheld (${proposal.withheld})` : 'withheld')}`,
  )
  if (proposal.refusal) console.log(`refused: ${proposal.refusal}`)
  console.log(`digest: ${proposal.digest}`)
  console.log('digest is not authorization')
}

/** Preview by default; apply requires a matching digest and separate operator text. */
export async function initFeature(args: string[], deps: FeatureInitDeps = {}): Promise<FeatureProposal> {
  const parsed = featureArgs(args)
  const dir = parsed.dir ?? process.cwd()
  const preview = await previewFeatureInit(dir, deps)
  printProposal(preview)
  if (parsed.dryRun || parsed.approve === undefined) return preview
  // Strip whitespace + Cf (ZWSP/ZWNJ/…) so digest±format-chars cannot pass as a
  // distinct operator reply (Spec B: digest is not authorization).
  const operatorApproval = (parsed.operatorApproval ?? '').replace(/[\s\p{Cf}]/gu, '')
  if (
    !parsed.approve ||
    !operatorApproval ||
    operatorApproval === parsed.approve ||
    operatorApproval === preview.digest
  ) {
    throw new Error('init=refused explicit operator approval is required')
  }
  if (parsed.approve !== preview.digest) throw new Error('init=refused approval digest does not match the preview')
  if (deps.principal ?? isPrincipal(preview.checkout)) {
    const error = new Error('init=refused principal')
    ;(error as Error & { exitCode?: number }).exitCode = 2
    throw error
  }
  if (preview.refusal) throw new Error(`init=refused ${preview.refusal}`)
  if (!preview.stack.additions.length && !trackerChanges(preview.tracker)) {
    console.log('init=noop')
    return preview
  }
  const reread = await previewFeatureInit(preview.checkout, deps)
  if (reread.digest !== preview.digest || Boolean(reread.tracker) !== Boolean(preview.tracker)) {
    throw new Error('init=refused plan changed before apply')
  }
  if (reread.stack.after !== null && reread.stack.after !== reread.stack.before) {
    const stackPath = join(reread.checkout, '.dev', 'stack.yml')
    mkdirSync(dirname(stackPath), { recursive: true })
    writeFileSync(stackPath, reread.stack.after)
  }
  if (reread.tracker && trackerChanges(reread.tracker)) {
    await (deps.triage ?? (await loadTriageInit())).applyApprovedPlan(
      reread.tracker.plan,
      reread.tracker.contractText,
      reread.tracker.deps,
    )
  }
  return preview
}

if (import.meta.main) {
  try {
    await initFeature(process.argv.slice(2))
  } catch (err) {
    const error = err as Error & { exitCode?: number }
    if (err instanceof IssueTriageMissing) {
      console.error(`init=blocked ${error.message}`)
      process.exit(3)
    }
    console.error(error.message)
    process.exit(error.exitCode ?? 1)
  }
}
