import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface WatchEntry {
  name: string
  owner: string
  repo: string
  source: string
  baseline: string
  branch: string
  watchedPaths: readonly string[]
}

export interface Compare {
  files: readonly { filename: string }[]
  commits: readonly unknown[]
}

export interface Drift {
  entry: WatchEntry
  head: string
  changedPaths: readonly string[]
}

export class UpstreamWatchError extends Error {}

const SAFE_NAME = /^[A-Za-z0-9._-]+$/
const SAFE_PATH = /^[A-Za-z0-9._/-]+$/

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new UpstreamWatchError(`${label} must be an object`)
  return value as Record<string, unknown>
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') throw new UpstreamWatchError(`${label} must be a non-empty string`)
  return value
}

function githubSource(source: string): { owner: string; repo: string } {
  const url = new URL(source)
  const parts = url.pathname.split('/').filter(Boolean)
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    parts.length !== 2 ||
    !parts.every((part) => SAFE_NAME.test(part))
  ) {
    throw new UpstreamWatchError(`unsupported upstream source: ${source}`)
  }
  return { owner: parts[0], repo: parts[1] }
}

/** Only an explicit watched_paths declaration makes a curated entry an upstream dependency. */
export function selectWatchedEntries(registry: unknown): WatchEntry[] {
  const root = object(registry, 'registry')
  if (!Array.isArray(root.curated_marketplaces))
    throw new UpstreamWatchError('registry curated_marketplaces must be an array')
  return root.curated_marketplaces.flatMap((value, index) => {
    const row = object(value, `curated_marketplaces[${index}]`)
    if (!Object.hasOwn(row, 'watched_paths')) return []
    if (!Array.isArray(row.watched_paths) || row.watched_paths.length === 0) {
      throw new UpstreamWatchError(`curated_marketplaces[${index}] watched_paths must be a non-empty array`)
    }
    const watchedPaths = row.watched_paths.map((path, pathIndex) => {
      const value = text(path, `curated_marketplaces[${index}] watched_paths[${pathIndex}]`)
      if (!SAFE_PATH.test(value) || value.startsWith('/') || value.endsWith('/')) {
        throw new UpstreamWatchError(`invalid watched path: ${value}`)
      }
      return value
    })
    const name = text(row.name, `curated_marketplaces[${index}] name`)
    if (!SAFE_NAME.test(name)) throw new UpstreamWatchError(`invalid entry name: ${name}`)
    const source = text(row.source, `curated_marketplaces[${index}] source`)
    const { owner, repo } = githubSource(source)
    return [
      {
        name,
        owner,
        repo,
        source,
        baseline: text(row.last_checked_commit, `${name} last_checked_commit`),
        branch: text(row.upstream_branch, `${name} upstream_branch`),
        watchedPaths,
      },
    ]
  })
}

export function pathMatches(watchedPath: string, changedPath: string): boolean {
  return changedPath === watchedPath || changedPath.startsWith(`${watchedPath}/`)
}

export function compareIsTruncated(compare: Compare): boolean {
  return compare.files.length >= 300 || compare.commits.length >= 250
}

export function changedWatchedPaths(paths: readonly string[], files: readonly { filename: string }[]): string[] {
  return paths.filter((path) => files.some((file) => pathMatches(path, file.filename)))
}

export function detectDrift(
  entry: WatchEntry,
  head: string,
  compare: Compare,
  fallbackChangedPaths: readonly string[] | null = null,
): Drift | null {
  if (!SAFE_NAME.test(head)) throw new UpstreamWatchError(`invalid upstream head for ${entry.name}`)
  const truncated = compareIsTruncated(compare)
  if (truncated) {
    if (fallbackChangedPaths === null) {
      throw new UpstreamWatchError(`truncated compare response for ${entry.name} requires path-scoped fallback`)
    }
    return fallbackChangedPaths.length === 0 ? null : { entry, head, changedPaths: fallbackChangedPaths }
  }
  const changedPaths = changedWatchedPaths(entry.watchedPaths, compare.files)
  return changedPaths.length === 0 ? null : { entry, head, changedPaths }
}

export interface ExistingIssue {
  number: number
  body: string | null
}

export function issueMarker(entry: WatchEntry): string {
  return `<!-- upstream-watch: ${entry.name} -->`
}

export function existingIssueAction(entry: WatchEntry, issues: readonly ExistingIssue[]): 'create' | 'refresh' {
  const matching = issues.filter((issue) => issue.body?.includes(issueMarker(entry)))
  if (matching.length > 1) throw new UpstreamWatchError(`multiple open issues carry ${issueMarker(entry)}`)
  return matching.length === 1 ? 'refresh' : 'create'
}

export function renderIssue(drift: Drift): string {
  const { entry, head, changedPaths } = drift
  const compare = `${entry.source}/compare/${entry.baseline}...${head}`
  return [
    issueMarker(entry),
    '',
    `## Upstream drift: \`${entry.name}\``,
    '',
    '| Field | Value |',
    '|---|---|',
    `| Upstream | [${entry.owner}/${entry.repo}](${entry.source}) |`,
    `| Branch | \`${entry.branch}\` |`,
    `| Baseline | \`${entry.baseline}\` |`,
    `| Head | \`${head}\` |`,
    `| Compare | [${entry.baseline.slice(0, 12)}...${head.slice(0, 12)}](${compare}) |`,
    '',
    '### Changed watched paths',
    '',
    ...changedPaths.map((path) => `- \`${path}\``),
    '',
    '### Review steps',
    '',
    `1. Review the [upstream change](${compare}) for the watched paths.`,
    '2. If the dependency remains suitable, bump `last_checked_commit` in `.claude-plugin/external-registry.json`.',
    '',
    '> This issue was opened automatically by the Upstream Watch workflow. CI never auto-merges.',
    '',
  ].join('\n')
}

class Gh {
  json<T>(args: string[]): T {
    const result = Bun.spawnSync(['gh', ...args], { stdout: 'pipe', stderr: 'pipe' })
    if (result.exitCode !== 0) throw new UpstreamWatchError(`gh ${args.join(' ')}: ${result.stderr.toString().trim()}`)
    try {
      return JSON.parse(result.stdout.toString()) as T
    } catch {
      throw new UpstreamWatchError(`gh ${args.join(' ')} returned invalid JSON`)
    }
  }

  write(args: string[]): void {
    const result = Bun.spawnSync(['gh', ...args], { stdout: 'pipe', stderr: 'pipe' })
    if (result.exitCode !== 0) throw new UpstreamWatchError(`gh ${args.join(' ')}: ${result.stderr.toString().trim()}`)
  }
}

function pages<T>(value: unknown, label: string): T[] {
  if (!Array.isArray(value) || !value.every(Array.isArray))
    throw new UpstreamWatchError(`${label} pagination response is invalid`)
  return value.flat() as T[]
}

function pathScopedChanges(gh: Gh, entry: WatchEntry, head: string): string[] {
  return entry.watchedPaths.filter((path) => {
    const commits = pages<{ sha?: unknown }>(
      gh.json([
        'api',
        '--paginate',
        '--slurp',
        `repos/${entry.owner}/${entry.repo}/commits?sha=${head}&path=${encodeURIComponent(path)}&per_page=100`,
      ]),
      `${entry.name} ${path}`,
    )
    return commits.some((commit) => {
      const sha = text(commit.sha, `${entry.name} ${path} commit sha`)
      const ancestry = gh.json<{ ahead_by?: unknown }>([
        'api',
        `repos/${entry.owner}/${entry.repo}/compare/${entry.baseline}...${sha}`,
      ])
      if (!Number.isInteger(ancestry.ahead_by))
        throw new UpstreamWatchError(`invalid ancestry response for ${entry.name} ${path}`)
      return (ancestry.ahead_by as number) > 0
    })
  })
}

function issuePayload(title: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'upstream-watch-'))
  const path = join(dir, 'issue.json')
  writeFileSync(path, JSON.stringify({ title, body, labels: ['ci'] }))
  return path
}

function deliverIssue(
  gh: Gh,
  repository: string,
  drift: Drift,
  issues: readonly ExistingIssue[],
  dryRun: boolean,
): void {
  const action = existingIssueAction(drift.entry, issues)
  const title = `upstream drift: ${drift.entry.name} (omp-build dependency)`
  const body = renderIssue(drift)
  if (dryRun) {
    console.log(`${action}: ${drift.entry.name} (${drift.changedPaths.join(', ')})`)
    return
  }
  const path = issuePayload(title, body)
  try {
    if (action === 'create') gh.write(['api', '-X', 'POST', `repos/${repository}/issues`, '--input', path])
    else {
      const issue = issues.find((candidate) => candidate.body?.includes(issueMarker(drift.entry)))
      gh.write(['api', '-X', 'PATCH', `repos/${repository}/issues/${issue?.number}`, '--input', path])
    }
  } finally {
    rmSync(join(path, '..'), { recursive: true, force: true })
  }
}

export function main(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): number {
  try {
    if (argv.length > 1) throw new UpstreamWatchError('usage: upstream-watch.ts [registry path]')
    const repository = text(env.GITHUB_REPOSITORY, 'GITHUB_REPOSITORY')
    const entries = selectWatchedEntries(
      JSON.parse(readFileSync(argv[0] ?? '.claude-plugin/external-registry.json', 'utf8')),
    )
    const gh = new Gh()
    const issues = pages<ExistingIssue>(
      gh.json(['api', '--paginate', '--slurp', `repos/${repository}/issues?state=open&labels=ci&per_page=100`]),
      'open issues',
    )
    let drifts = 0
    for (const entry of entries) {
      const head = text(
        gh.json<{ sha?: unknown }>(['api', `repos/${entry.owner}/${entry.repo}/commits/${entry.branch}`]).sha,
        `${entry.name} head`,
      )
      const compare = gh.json<Compare>([
        'api',
        `repos/${entry.owner}/${entry.repo}/compare/${entry.baseline}...${head}`,
      ])
      const fallback = compareIsTruncated(compare) ? pathScopedChanges(gh, entry, head) : []
      const drift = detectDrift(entry, head, compare, fallback)
      if (!drift) continue
      deliverIssue(gh, repository, drift, issues, env.UPSTREAM_WATCH_DRY_RUN === '1')
      drifts += 1
    }
    console.log(`Upstream Watch complete. ${drifts} drift(s) detected.`)
    return 0
  } catch (error) {
    console.error(`upstream-watch: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2))
