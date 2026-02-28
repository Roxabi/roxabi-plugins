/**
 * GitHub API helpers — shared across skills.
 * Uses direct fetch() against GitHub API with GITHUB_TOKEN.
 */

import { GITHUB_REPO, PROJECT_ID } from './config'
import {
  ADD_BLOCKED_BY_MUTATION,
  ADD_SUB_ISSUE_MUTATION,
  ADD_TO_PROJECT_MUTATION,
  ITEM_ID_QUERY,
  PARENT_QUERY,
  REMOVE_BLOCKED_BY_MUTATION,
  REMOVE_SUB_ISSUE_MUTATION,
  UPDATE_FIELD_MUTATION,
} from './queries'

const GITHUB_API = 'https://api.github.com'
const GRAPHQL_URL = `${GITHUB_API}/graphql`

let cachedToken: string | undefined

function getToken(): string {
  if (cachedToken) return cachedToken

  // Prefer env var (set in .env or CI secrets)
  if (process.env.GITHUB_TOKEN) {
    cachedToken = process.env.GITHUB_TOKEN
    return cachedToken
  }

  // Fallback: extract from gh CLI auth (local dev convenience)
  try {
    const proc = Bun.spawnSync(['gh', 'auth', 'token'], { stdout: 'pipe', stderr: 'pipe' })
    const token = new TextDecoder().decode(proc.stdout).trim()
    if (token) {
      cachedToken = token
      return cachedToken
    }
  } catch {
    // gh not available
  }

  throw new Error('GITHUB_TOKEN env var required (or gh auth login for local dev)')
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${getToken()}`,
    'Content-Type': 'application/json',
    'User-Agent': 'roxabi-skills',
  }
}

/** Run a local shell command and return trimmed stdout. Throws on non-zero exit. */
export async function run(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const code = await proc.exited

  if (code !== 0) {
    throw new Error(`Command failed (${code}): ${cmd.join(' ')}\n${stderr}`)
  }
  return stdout.trim()
}

/** Execute a GraphQL query/mutation against GitHub API. */
export async function ghGraphQL(
  query: string,
  variables: Record<string, string | number>
): Promise<unknown> {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ query, variables }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`GitHub GraphQL error (${res.status}): ${text}`)
  }

  const json = (await res.json()) as { errors?: { message: string }[] }
  if (json.errors?.length) {
    throw new Error(`GitHub GraphQL error: ${JSON.stringify(json.errors)}`)
  }
  return json
}

/** Get issue node ID via REST API. */
export async function getNodeId(issueNumber: number | string): Promise<string> {
  const res = await fetch(`${GITHUB_API}/repos/${GITHUB_REPO}/issues/${issueNumber}`, {
    headers: authHeaders(),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Failed to get node ID for #${issueNumber} (${res.status}): ${text}`)
  }
  const data = (await res.json()) as { node_id: string }
  return data.node_id
}

/** Create a new GitHub issue via REST API. Returns the issue URL and number. */
export async function createGitHubIssue(
  title: string,
  body?: string,
  labels?: string[]
): Promise<{ url: string; number: number }> {
  const payload: Record<string, unknown> = { title }
  if (body) payload.body = body
  if (labels?.length) payload.labels = labels

  const res = await fetch(`${GITHUB_API}/repos/${GITHUB_REPO}/issues`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(payload),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Failed to create issue (${res.status}): ${text}`)
  }

  const data = (await res.json()) as { html_url: string; number: number }
  return { url: data.html_url, number: data.number }
}

/** Get project item ID for an issue number. */
export async function getItemId(issueNumber: number): Promise<string> {
  const [owner, repo] = GITHUB_REPO.split('/')
  const data = (await ghGraphQL(ITEM_ID_QUERY, { owner, repo, number: issueNumber })) as {
    data: {
      repository: {
        issue: { projectItems: { nodes: { id: string; project: { id: string } }[] } }
      }
    }
  }
  const items = data.data.repository.issue.projectItems.nodes
  const item = items.find((i) => i.project.id === PROJECT_ID)
  if (!item) throw new Error(`Issue #${issueNumber} not found in project`)
  return item.id
}

/** Add an issue to the project board. Returns the new item ID. */
export async function addToProject(nodeId: string): Promise<string> {
  const data = (await ghGraphQL(ADD_TO_PROJECT_MUTATION, {
    projectId: PROJECT_ID,
    contentId: nodeId,
  })) as { data: { addProjectV2ItemById: { item: { id: string } } } }
  return data.data.addProjectV2ItemById.item.id
}

/** Update a single-select project field value. */
export async function updateField(
  itemId: string,
  fieldId: string,
  optionId: string
): Promise<void> {
  await ghGraphQL(UPDATE_FIELD_MUTATION, {
    projectId: PROJECT_ID,
    itemId,
    fieldId,
    optionId,
  })
}

/** Add a blocked-by dependency between two issues. */
export async function addBlockedBy(issueId: string, blockingId: string): Promise<void> {
  await ghGraphQL(ADD_BLOCKED_BY_MUTATION, { issueId, blockingId })
}

/** Remove a blocked-by dependency between two issues. */
export async function removeBlockedBy(issueId: string, blockingId: string): Promise<void> {
  await ghGraphQL(REMOVE_BLOCKED_BY_MUTATION, { issueId, blockingId })
}

/** Add a sub-issue (parent/child) relationship. */
export async function addSubIssue(parentId: string, childId: string): Promise<void> {
  await ghGraphQL(ADD_SUB_ISSUE_MUTATION, { parentId, childId })
}

/** Remove a sub-issue (parent/child) relationship. */
export async function removeSubIssue(parentId: string, childId: string): Promise<void> {
  await ghGraphQL(REMOVE_SUB_ISSUE_MUTATION, { parentId, childId })
}

/** Get the parent issue number for an issue, or null if none. */
export async function getParentNumber(issueNumber: number): Promise<number | null> {
  const [owner, repo] = GITHUB_REPO.split('/')
  const data = (await ghGraphQL(PARENT_QUERY, { owner, repo, number: issueNumber })) as {
    data: { repository: { issue: { parent: { number: number } | null } } }
  }
  return data.data.repository.issue.parent?.number ?? null
}
