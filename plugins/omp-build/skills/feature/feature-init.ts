#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export type MigrateLabel = (name: string) => { add: string | null; remove: boolean }

export class IssueTriageMissing extends Error {
  constructor(detail?: string) {
    super(detail ? `issue-triage missing (${detail})` : 'issue-triage missing')
    this.name = 'IssueTriageMissing'
  }
}

const MIGRATE_LABELS = join('skills', 'issue-triage', 'lib', 'migrate-labels.ts')

/**
 * Where issue-triage's migration grammar may live: this repository's sibling
 * plugin first, then the installed layout. For the latter, the walk up this
 * file's real path stops at the first ancestor holding `node_modules/omp-build`
 * (`~/.omp/plugins`) and looks only at its `node_modules/issue-triage`, so an
 * unrelated `node_modules` higher up (say `/tmp`) is never reached. An
 * ancestor that is world-writable (sticky or not) or not owned by the current
 * user is never trusted as that stop, nor is its `node_modules`. Only
 * absolute file paths are imported, never a bare specifier, so Bun has nothing
 * to auto-install from a registry.
 */
/** Owned by the current user and not world-writable. The sticky bit does not make a directory trusted. */
export function trustedDir(dir: string, uid: number | undefined = process.getuid?.()): boolean {
  try {
    const stat = statSync(dir)
    return (stat.mode & 0o002) === 0 && (uid === undefined || stat.uid === uid)
  } catch {
    return false
  }
}

export function migrateLabelCandidates(from: string): string[] {
  const here = dirname(realpathSync(from))
  const out = [join(here, '..', '..', '..', 'issue-triage', MIGRATE_LABELS)]
  for (let dir = here; ; dir = dirname(dir)) {
    if (
      trustedDir(dir) &&
      trustedDir(join(dir, 'node_modules')) &&
      existsSync(join(dir, 'node_modules', 'omp-build'))
    ) {
      out.push(join(dir, 'node_modules', 'issue-triage', MIGRATE_LABELS))
      break
    }
    if (dirname(dir) === dir) break
  }
  return out
}

/** Imports the first candidate that exists. An import error there is final: no later candidate is tried. */
export async function loadMigrateLabel(from: string = fileURLToPath(import.meta.url)): Promise<MigrateLabel> {
  const file = migrateLabelCandidates(from).find((candidate) => existsSync(candidate))
  if (!file) throw new IssueTriageMissing('not found next to omp-build or in node_modules')
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
  if (facts.activeContracts > 0) lines.push(`${facts.activeContracts} orphan contracts`)
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

export function applyStack(dir: string, facts: Facts): void {
  const stackPath = join(dir, '.dev', 'stack.yml')
  let stack = existsSync(stackPath) ? readFileSync(stackPath, 'utf8') : 'schema_version: "1.0"\n'
  if (!facts.hasWorktree) {
    stack += '\nworktree:\n  copy: []\n  seed: []\n  setup: ""\n'
  }
  if (facts.mergeOnGreen && !/^landing:/m.test(stack)) {
    stack += '\nlanding:\n  mode: merge-on-green\n'
  }
  mkdirSync(dirname(stackPath), { recursive: true })
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
  let facts: Facts
  try {
    facts = await readFacts(dir)
  } catch (err) {
    if (!(err instanceof IssueTriageMissing)) throw err
    console.error(`init=blocked ${err.message}`)
    process.exit(3)
  }
  const planned = plan(facts)
  console.log(trackerNext(dry))
  if (dry) {
    for (const line of planned) console.log(line)
    process.exit(0)
  }
  applyStack(dir, facts)
  for (const line of planned) console.log(line)
}
