/**
 * GitHub adapter — standalone helper functions wrapping GitHub REST + GraphQL APIs.
 * Exports canonical getGitHubToken() for auth, plus all operational helpers.
 */

import { ConfigError, DevCoreError, GitHubApiError } from '../domain/errors'
import {
  ADD_BLOCKED_BY_MUTATION,
  ADD_SUB_ISSUE_MUTATION,
  ORG_ISSUE_TYPES_QUERY,
  PARENT_QUERY,
  REMOVE_BLOCKED_BY_MUTATION,
  REMOVE_SUB_ISSUE_MUTATION,
  UPDATE_ISSUE_ISSUE_TYPE_MUTATION,
  UPDATE_ISSUE_TYPE_MUTATION,
} from '../queries'

const GITHUB_API = 'https://api.github.com'
const GRAPHQL_URL = `${GITHUB_API}/graphql`

// --- Standalone helper functions ---

import { GITHUB_REPO } from './config-helpers'

let cachedToken: string | undefined

export function getGitHubToken(): string {
  if (cachedToken) return cachedToken

  if (process.env.GITHUB_TOKEN) {
    cachedToken = process.env.GITHUB_TOKEN
    return cachedToken
  }

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

  throw new ConfigError('GITHUB_TOKEN env var required (or gh auth login for local dev)')
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${getGitHubToken()}`,
    'Content-Type': 'application/json',
    'User-Agent': 'roxabi-skills',
  }
}

/** Run a local shell command and return trimmed stdout. Throws on non-zero exit. */
export async function run(cmd: string[], cwd?: string): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe', cwd })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const code = await proc.exited

  if (code !== 0) {
    throw new DevCoreError(`Command failed (${code}): ${cmd.join(' ')}\n${stderr}`)
  }
  return stdout.trim()
}

/** Execute a GraphQL query/mutation against GitHub API. */
export async function ghGraphQL(query: string, variables: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ query, variables }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new GitHubApiError(`GitHub GraphQL error (${res.status}): ${text}`, res.status)
  }

  const json = (await res.json()) as { errors?: { message: string }[] }
  if (json.errors?.length) {
    throw new GitHubApiError(`GitHub GraphQL error: ${JSON.stringify(json.errors)}`)
  }
  return json
}

/** Get issue node ID via REST API. */
export async function getNodeId(issueNumber: number | string, repo?: string): Promise<string> {
  const repoSlug = repo ?? GITHUB_REPO
  const res = await fetch(`${GITHUB_API}/repos/${repoSlug}/issues/${issueNumber}`, {
    headers: authHeaders(),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new GitHubApiError(`Failed to get node ID for #${issueNumber} (${res.status}): ${text}`, res.status)
  }
  const data = (await res.json()) as { node_id: string }
  return data.node_id
}

/** Create a new GitHub issue via REST API. Returns the issue URL and number. */
export async function createGitHubIssue(
  title: string,
  body?: string,
  labels?: string[],
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
    throw new GitHubApiError(`Failed to create issue (${res.status}): ${text}`, res.status)
  }

  const data = (await res.json()) as { html_url: string; number: number }
  return { url: data.html_url, number: data.number }
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

export interface OrgIssueType {
  id: string
  name: string
  color: string
  isEnabled: boolean
}

export async function listOrgIssueTypes(login: string): Promise<OrgIssueType[]> {
  const data = (await ghGraphQL(ORG_ISSUE_TYPES_QUERY, { login })) as {
    data: { organization: { issueTypes: { nodes: OrgIssueType[] } } }
  }
  return data.data.organization.issueTypes.nodes
}

export async function updateIssueType(
  issueTypeId: string,
  patch: { name?: string; description?: string; color?: string; isEnabled?: boolean },
): Promise<OrgIssueType> {
  const data = (await ghGraphQL(UPDATE_ISSUE_TYPE_MUTATION, {
    issueTypeId,
    ...(patch.name !== undefined && { name: patch.name }),
    ...(patch.description !== undefined && { description: patch.description }),
    ...(patch.color !== undefined && { color: patch.color }),
    ...(patch.isEnabled !== undefined && { isEnabled: patch.isEnabled }),
  })) as { data: { updateIssueType: { issueType: OrgIssueType } } }
  return data.data.updateIssueType.issueType
}

/** Update labels on a GitHub issue: add and/or remove labels. */
export async function updateLabels(
  issueNumber: number,
  add: string[],
  remove: string[],
  repo: string = GITHUB_REPO,
): Promise<void> {
  let removeExisting = remove
  if (remove.length) {
    const out = await run([
      'gh',
      'label',
      'list',
      '--repo',
      repo,
      '--limit',
      '200',
      '--json',
      'name',
      '--jq',
      '.[].name',
    ])
    const existing = new Set(
      out
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
    )
    removeExisting = remove.filter((l) => existing.has(l))
  }
  const args = ['gh', 'issue', 'edit', String(issueNumber), '--repo', repo]
  if (add.length) args.push('--add-label', add.join(','))
  if (removeExisting.length) args.push('--remove-label', removeExisting.join(','))
  await run(args)
}

/** Update the issue type on a GitHub issue. Pass null issueTypeId to clear. */
export async function updateIssueIssueType(issueNodeId: string, issueTypeId: string | null): Promise<void> {
  // FIXME(#121): revert with null issueTypeId is unverified — schema allows it but API behaviour unconfirmed.
  // Manual verification needed before production revert. Raw mutation error surfaces via ghGraphQL throw.
  await ghGraphQL(UPDATE_ISSUE_ISSUE_TYPE_MUTATION, { issueId: issueNodeId, issueTypeId })
}

/** Resolve an issue type name to its node ID for a given org (case-insensitive). */
export async function resolveIssueTypeId(org: string, typeName: string): Promise<string> {
  const types = await listOrgIssueTypes(org)
  const match = types.find((t) => t.name.toLowerCase() === typeName.toLowerCase())
  if (!match) {
    const valid = types.map((t) => t.name).join(', ')
    throw new GitHubApiError(`Unknown issue type: ${typeName}. Valid: ${valid}`)
  }
  return match.id
}

/** Get the parent issue number for an issue, or null if none. */
export async function getParentNumber(issueNumber: number): Promise<number | null> {
  const [owner, repo] = GITHUB_REPO.split('/')
  const data = (await ghGraphQL(PARENT_QUERY, { owner, repo, number: issueNumber })) as {
    data: { repository: { issue: { parent: { number: number } | null } } }
  }
  return data.data.repository.issue.parent?.number ?? null
}

export interface IssueLabelSet {
  number: number
  labels: string[]
  body: string
}

/** Label names defined on the repository. Does not delete any. */
export async function listLabelNames(repo: string = GITHUB_REPO): Promise<string[]> {
  const out = await run(['gh', 'label', 'list', '--repo', repo, '--limit', '500', '--json', 'name', '--jq', '.[].name'])
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

/**
 * Create a label definition when it is missing. An existing name is left
 * untouched — including its color. Never deletes a definition.
 */
export async function ensureLabel(name: string, repo: string = GITHUB_REPO): Promise<'created' | 'present'> {
  const existing = await listLabelNames(repo)
  if (existing.includes(name)) return 'present'
  await run(['gh', 'label', 'create', name, '--repo', repo, '--color', 'ededed'])
  return 'created'
}

/** Every issue (not pull request) with its labels and body. Read-only. */
export async function listIssueLabelSets(repo: string = GITHUB_REPO): Promise<IssueLabelSet[]> {
  const out = await run([
    'gh',
    'issue',
    'list',
    '--repo',
    repo,
    '--state',
    'all',
    '--limit',
    '5000',
    '--json',
    'number,labels,body',
  ])
  const rows = JSON.parse(out) as { number: number; labels: { name: string }[]; body: string | null }[]
  return rows.map((row) => ({
    number: row.number,
    labels: (row.labels ?? []).map((label) => label.name),
    body: row.body ?? '',
  }))
}
