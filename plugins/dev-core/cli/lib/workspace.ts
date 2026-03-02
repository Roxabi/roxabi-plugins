import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'

export interface WorkspaceProject {
  repo: string              // 'owner/name'
  projectId: string         // 'PVT_...'
  label: string             // display name shown in dashboard tab
  vercelProjectId?: string  // Vercel project ID (optional, for per-project deployments)
  vercelTeamId?: string     // Vercel team ID (optional)
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
  writeFileSync(p, JSON.stringify(ws, null, 2) + '\n', { mode: 0o600 })
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

  const token = process.env.GITHUB_TOKEN || (() => {
    const proc = Bun.spawnSync(['gh', 'auth', 'token'], { stdout: 'pipe', stderr: 'pipe' })
    return new TextDecoder().decode(proc.stdout).trim()
  })()
  if (!token) throw new Error('Not authenticated. Run: gh auth login or set GITHUB_TOKEN env var')

  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { owner, name } }),
  })
  if (!res.ok) throw new Error(`GitHub API error: ${res.status} ${res.statusText}`)

  const json = await res.json() as {
    data: { repository: { projectsV2: { nodes: { id: string; title: string }[] } } }
  }
  return (json.data?.repository?.projectsV2?.nodes ?? []).map(n => ({
    repo, projectId: n.id, label: n.title,
  }))
}
