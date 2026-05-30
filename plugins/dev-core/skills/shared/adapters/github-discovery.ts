import { ConfigError, GitHubApiError } from '../domain/errors'
import type { WorkspaceProject } from '../ports/workspace'
import { getGitHubToken } from './github-adapter'

/**
 * Discover GitHub Projects linked to a repo via GraphQL.
 * Returns array of WorkspaceProject (may be 0, 1, or multiple).
 *
 * `localPath` is optional — callers that know the local clone path pass it in.
 * Previously this was auto-detected via detectLocalPath() (cli-only, Bun.spawnSync);
 * moving detection responsibility to the caller keeps this module cli-free.
 */
export async function discoverProject(repo: string, localPath?: string): Promise<WorkspaceProject[]> {
  const [owner, name] = repo.split('/')
  if (!owner || !name) throw new ConfigError(`Invalid repo format: '${repo}'. Use 'owner/name'.`)

  const query = `query($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      projectsV2(first: 10) { nodes { id title } }
    }
  }`

  const token = getGitHubToken()

  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { owner, name } }),
  })
  if (!res.ok) throw new GitHubApiError(`GitHub API error: ${res.status} ${res.statusText}`, res.status)

  const json = (await res.json()) as {
    data: { repository: { projectsV2: { nodes: { id: string; title: string }[] } } }
  }
  return (json.data?.repository?.projectsV2?.nodes ?? []).map((n) => ({
    repo,
    projectId: n.id,
    label: n.title,
    ...(localPath ? { localPath } : {}),
  }))
}
