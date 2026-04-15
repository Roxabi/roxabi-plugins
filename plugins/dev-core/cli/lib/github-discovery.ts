import { detectLocalPath } from './cwd-resolver'
import type { WorkspaceProject } from './workspace-store'

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
