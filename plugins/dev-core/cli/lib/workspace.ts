import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

export interface VercelProjectRef {
  projectId: string
  teamId: string
}

export interface WorkspaceProject {
  repo: string // 'owner/name'
  projectId: string // 'PVT_...'
  label: string // display name shown in dashboard tab
  localPath?: string // absolute path to local clone — used by dashboard for git ops
  vercelProjectId?: string // single Vercel project ID (legacy / single-project)
  vercelTeamId?: string // Vercel team ID for single project
  vercelProjects?: VercelProjectRef[] // multiple Vercel projects (overrides vercelProjectId)
}

export interface Workspace {
  projects: WorkspaceProject[]
}

export function getWorkspacePath(): string {
  const home = process.env.HOME ?? ''
  const vault = `${home}/.roxabi-vault`
  if (existsSync(vault)) return `${vault}/workspace.json`
  return `${home}/.config/roxabi/workspace.json`
}

export function readWorkspace(): Workspace {
  const p = getWorkspacePath()
  if (!existsSync(p)) return { projects: [] }
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Workspace
  } catch {
    return { projects: [] }
  }
}

export function writeWorkspace(ws: Workspace): void {
  const p = getWorkspacePath()
  const dir = p.substring(0, p.lastIndexOf('/'))
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  writeFileSync(p, `${JSON.stringify(ws, null, 2)}\n`, { mode: 0o600 })
}

/**
 * Discover GitHub Projects linked to a repo via GraphQL.
 * Returns array of WorkspaceProject (may be 0, 1, or multiple).
 */
export async function discoverProject(repo: string): Promise<WorkspaceProject[]> {
  const [owner, name] = repo.split('/')
  if (!owner || !name) throw new Error(`Invalid repo format: '${repo}'. Use 'owner/name'.`)

  const query = `query($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      projectsV2(first: 10) { nodes { id title } }
    }
  }`

  const token =
    process.env.GITHUB_TOKEN ||
    (() => {
      const proc = Bun.spawnSync(['gh', 'auth', 'token'], { stdout: 'pipe', stderr: 'pipe' })
      return new TextDecoder().decode(proc.stdout).trim()
    })()
  if (!token) throw new Error('Not authenticated. Run: gh auth login or set GITHUB_TOKEN env var')

  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { owner, name } }),
  })
  if (!res.ok) throw new Error(`GitHub API error: ${res.status} ${res.statusText}`)

  const json = (await res.json()) as {
    data: { repository: { projectsV2: { nodes: { id: string; title: string }[] } } }
  }
  const localPath = detectLocalPath(repo)
  return (json.data?.repository?.projectsV2?.nodes ?? []).map((n) => ({
    repo,
    projectId: n.id,
    label: n.title,
    ...(localPath ? { localPath } : {}),
  }))
}

/**
 * Parse a git remote URL into 'owner/name'.
 * Handles SSH (git@host:owner/name.git), HTTPS (https://host/owner/name[.git]),
 * and ssh:// / git:// URLs. Returns null if the URL is not recognizable.
 */
export function parseGitRemoteUrl(url: string): string | null {
  const trimmed = url.trim().replace(/\.git$/, '')
  // SSH shorthand: git@github.com:owner/name
  const ssh = trimmed.match(/^[^@\s]+@[^:\s]+:([^/\s]+)\/(.+)$/)
  if (ssh) return `${ssh[1]}/${ssh[2]}`
  // Protocol URLs: https://, ssh://, git://
  const web = trimmed.match(/^(?:https?|ssh|git):\/\/[^/]+\/([^/]+)\/(.+?)$/)
  if (web) return `${web[1]}/${web[2]}`
  return null
}

/**
 * Resolve the repository slug ('owner/name') for a working directory.
 * Order: .roxabi marker walk-up → `git remote get-url origin` parse.
 * Returns null if no source yields a slug.
 */
export function resolveRepoFromCwd(cwd: string): string | null {
  // 1. .roxabi marker walk-up (supports monorepos / subdirs)
  let dir = cwd
  while (dir.length > 1) {
    const marker = `${dir}/.roxabi`
    if (existsSync(marker)) {
      try {
        const data = JSON.parse(readFileSync(marker, 'utf8')) as unknown
        if (data && typeof data === 'object' && 'repo' in data) {
          const repo = (data as { repo: unknown }).repo
          if (typeof repo === 'string' && repo.length > 0) return repo
        }
      } catch {
        // ignore malformed marker, fall through to git remote
      }
    }
    const parent = dir.substring(0, dir.lastIndexOf('/')) || '/'
    if (parent === dir) break
    dir = parent
  }

  // 2. git remote origin
  try {
    const proc = Bun.spawnSync(['git', '-C', cwd, 'remote', 'get-url', 'origin'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (proc.exitCode !== 0) return null
    const url = new TextDecoder().decode(proc.stdout).trim()
    return parseGitRemoteUrl(url)
  } catch {
    return null
  }
}

/**
 * Resolve a cwd to a registered project entry.
 * Order: exact localPath → prefix localPath → .roxabi marker or git remote origin.
 * Generic over project shape — any record with `repo` (and optional `localPath`) works.
 */
export function resolveCurrentProject<P extends { repo: string; localPath?: string }>(
  projects: P[],
  cwd: string,
): P | null {
  const byPath =
    projects.find((p) => p.localPath && cwd === p.localPath) ??
    projects.find((p) => p.localPath && cwd.startsWith(`${p.localPath}/`))
  if (byPath) return byPath

  const slug = resolveRepoFromCwd(cwd)
  if (!slug) return null
  const needle = slug.toLowerCase()
  return projects.find((p) => p.repo.toLowerCase() === needle) ?? null
}

/**
 * Try to find the local clone of a repo.
 * Prefers cwd if it is the repo itself, otherwise scans common directories.
 */
export function detectLocalPath(repo: string): string | undefined {
  const cwd = process.cwd()
  if (resolveRepoFromCwd(cwd)?.toLowerCase() === repo.toLowerCase()) return cwd

  const home = process.env.HOME
  const [, name] = repo.split('/')
  if (!home || !name) return undefined
  for (const dir of [`${home}/projects/${name}`, `${home}/${name}`, `${home}/src/${name}`]) {
    if (existsSync(`${dir}/.git`)) return dir
  }
  return undefined
}
