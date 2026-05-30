/**
 * GitHub adapter — standalone helper functions wrapping GitHub REST + GraphQL APIs.
 * Exports canonical getGitHubToken() for auth, plus all operational helpers.
 */
import {
  ADD_BLOCKED_BY_MUTATION,
  ADD_SUB_ISSUE_MUTATION,
  ADD_TO_PROJECT_MUTATION,
  CLEAR_FIELD_MUTATION,
  CREATE_ISSUE_TYPE_MUTATION,
  DELETE_PROJECT_ITEM_MUTATION,
  ITEM_ID_QUERY,
  LINK_PROJECT_TO_REPO_MUTATION,
  ORG_ISSUE_TYPES_QUERY,
  ORG_PROJECTS_QUERY,
  PARENT_QUERY,
  PROJECT_TITLE_QUERY,
  REMOVE_BLOCKED_BY_MUTATION,
  REMOVE_SUB_ISSUE_MUTATION,
  REPO_ID_QUERY,
  UPDATE_FIELD_MUTATION,
  UPDATE_ISSUE_ISSUE_TYPE_MUTATION,
  UPDATE_ISSUE_TYPE_MUTATION,
} from '../queries'

const GITHUB_API = 'https://api.github.com'
const GRAPHQL_URL = `${GITHUB_API}/graphql`

export type ProjectFieldKey = 'status' | 'size' | 'priority'

export interface ParsedField {
  id: string
  options: Record<string, string>
}

/** Parse gh project field-list JSON into a map of field key to {id, options}. */
export function parseProjectFields(fieldsJson: string): Record<ProjectFieldKey, ParsedField | null> {
  const result: Record<ProjectFieldKey, ParsedField | null> = { status: null, size: null, priority: null }
  const fields = JSON.parse(fieldsJson) as {
    fields: Array<{ id: string; name: string; options?: Array<{ id: string; name: string }> }>
  }
  for (const f of fields.fields ?? []) {
    const key = f.name.toLowerCase() as ProjectFieldKey
    if (key === 'status' || key === 'size' || key === 'priority') {
      const options: Record<string, string> = {}
      for (const opt of f.options ?? []) options[opt.name] = opt.id
      result[key] = { id: f.id, options }
    }
  }
  return result
}

// --- Standalone helper functions ---

import { GH_PROJECT_ID, GITHUB_REPO } from './config-helpers'

const GH_PROJECT_ID_NOT_CONFIGURED =
  'GH_PROJECT_ID not configured. Run `/init` or set gh_project_id in .claude/dev-core.yml.'

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

  throw new Error('GITHUB_TOKEN env var required (or gh auth login for local dev)')
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
    throw new Error(`Command failed (${code}): ${cmd.join(' ')}\n${stderr}`)
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
    throw new Error(`GitHub GraphQL error (${res.status}): ${text}`)
  }

  const json = (await res.json()) as { errors?: { message: string }[] }
  if (json.errors?.length) {
    throw new Error(`GitHub GraphQL error: ${JSON.stringify(json.errors)}`)
  }
  return json
}

/** Fetch issue numbers currently on a project board. */
export async function getBoardIssueNumbers(owner: string, projectNumber: number): Promise<Set<number>> {
  const itemsJson = await run([
    'gh',
    'project',
    'item-list',
    String(projectNumber),
    '--owner',
    owner,
    '--format',
    'json',
    '--limit',
    '500',
  ])
  const itemsData = JSON.parse(itemsJson) as { items: Array<{ content: { number: number; type: string } }> }
  return new Set((itemsData.items ?? []).filter((i) => i.content?.type === 'Issue').map((i) => i.content.number))
}

/** Get issue node ID via REST API. */
export async function getNodeId(issueNumber: number | string, repo?: string): Promise<string> {
  const repoSlug = repo ?? GITHUB_REPO
  const res = await fetch(`${GITHUB_API}/repos/${repoSlug}/issues/${issueNumber}`, {
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
    throw new Error(`Failed to create issue (${res.status}): ${text}`)
  }

  const data = (await res.json()) as { html_url: string; number: number }
  return { url: data.html_url, number: data.number }
}

/** Get project item ID for an issue number. */
export async function getItemId(
  issueNumber: number,
  overrides?: { projectId?: string; repo?: string },
): Promise<string> {
  const pid = overrides?.projectId ?? GH_PROJECT_ID
  const repoSlug = overrides?.repo ?? GITHUB_REPO
  if (!pid) throw new Error(GH_PROJECT_ID_NOT_CONFIGURED)
  const [owner, repo] = repoSlug.split('/')
  const data = (await ghGraphQL(ITEM_ID_QUERY, { owner, repo, number: issueNumber })) as {
    data: {
      repository: {
        issue: { projectItems: { nodes: { id: string; project: { id: string } }[] } }
      }
    }
  }
  const items = data.data.repository.issue.projectItems.nodes
  const item = items.find((i) => i.project.id === pid)
  if (!item) throw new Error(`Issue #${issueNumber} not found in project`)
  return item.id
}

/** Add an issue to the project board. Returns the new item ID. */
export async function addToProject(nodeId: string, projectId?: string): Promise<string> {
  const pid = projectId ?? GH_PROJECT_ID
  if (!pid) throw new Error(GH_PROJECT_ID_NOT_CONFIGURED)
  const data = (await ghGraphQL(ADD_TO_PROJECT_MUTATION, {
    projectId: pid,
    contentId: nodeId,
  })) as { data: { addProjectV2ItemById: { item: { id: string } } } }
  return data.data.addProjectV2ItemById.item.id
}

/** Remove an issue from the project board by its project item ID. */
export async function removeFromProject(itemId: string, projectId: string): Promise<void> {
  await ghGraphQL(DELETE_PROJECT_ITEM_MUTATION, { projectId, itemId })
}

/** Get a GitHub Project V2 title by its node ID. */
export async function getProjectTitle(projectId: string): Promise<string> {
  const data = (await ghGraphQL(PROJECT_TITLE_QUERY, { id: projectId })) as {
    data: { node: { title: string } }
  }
  return data.data.node.title
}

/** Update a single-select project field value. */
export async function updateField(
  itemId: string,
  fieldId: string,
  optionId: string,
  overrideProjectId?: string,
): Promise<void> {
  const pid = overrideProjectId ?? GH_PROJECT_ID
  if (!pid) throw new Error(GH_PROJECT_ID_NOT_CONFIGURED)
  await ghGraphQL(UPDATE_FIELD_MUTATION, {
    projectId: pid,
    itemId,
    fieldId,
    optionId,
  })
}

/** Clear a single-select project field value (set to null/unset). */
export async function clearField(itemId: string, fieldId: string, overrideProjectId?: string): Promise<void> {
  const pid = overrideProjectId ?? GH_PROJECT_ID
  if (!pid) throw new Error(GH_PROJECT_ID_NOT_CONFIGURED)
  await ghGraphQL(CLEAR_FIELD_MUTATION, {
    projectId: pid,
    itemId,
    fieldId,
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

/** Link a GitHub Project V2 to a repository so it appears in repository.projectsV2. */
export async function linkProjectToRepo(projectId: string, owner: string, repoName: string): Promise<void> {
  const repoData = (await ghGraphQL(REPO_ID_QUERY, { owner, name: repoName })) as {
    data: { repository: { id: string } }
  }
  const repositoryId = repoData.data.repository.id
  await ghGraphQL(LINK_PROJECT_TO_REPO_MUTATION, { projectId, repositoryId })
}

export interface OrgProject {
  id: string
  number: number
  title: string
}
export interface OrgIssueType {
  id: string
  name: string
  color: string
  isEnabled: boolean
}

export async function listOrgProjects(login: string): Promise<OrgProject[]> {
  const data = (await ghGraphQL(ORG_PROJECTS_QUERY, { login, first: 100 })) as {
    data: { organization: { projectsV2: { nodes: OrgProject[] } } }
  }
  return data.data.organization.projectsV2.nodes
}

export async function listOrgIssueTypes(login: string): Promise<OrgIssueType[]> {
  const data = (await ghGraphQL(ORG_ISSUE_TYPES_QUERY, { login })) as {
    data: { organization: { issueTypes: { nodes: OrgIssueType[] } } }
  }
  return data.data.organization.issueTypes.nodes
}

export async function createIssueType(
  ownerId: string,
  name: string,
  color: string,
  opts?: { description?: string; isEnabled?: boolean },
): Promise<OrgIssueType> {
  const data = (await ghGraphQL(CREATE_ISSUE_TYPE_MUTATION, {
    ownerId,
    name,
    description: opts?.description ?? '',
    color,
    isEnabled: opts?.isEnabled ?? true,
  })) as { data: { createIssueType: { issueType: OrgIssueType } } }
  return data.data.createIssueType.issueType
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
export async function updateLabels(issueNumber: number, add: string[], remove: string[]): Promise<void> {
  let removeExisting = remove
  if (remove.length) {
    const out = await run([
      'gh',
      'label',
      'list',
      '--repo',
      GITHUB_REPO,
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
  const args = ['gh', 'issue', 'edit', String(issueNumber), '--repo', GITHUB_REPO]
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
    throw new Error(`Unknown issue type: ${typeName}. Valid: ${valid}`)
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
