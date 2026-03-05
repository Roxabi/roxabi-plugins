/**
 * GitHubAdapter — concrete implementation of IssuePort + ProjectPort.
 * Wraps GitHub REST + GraphQL APIs.
 */
import type { Issue } from '../domain/types'
import type { IssueFilters, IssuePort } from '../ports/issue'
import type { ProjectPort } from '../ports/project'
import {
  ADD_BLOCKED_BY_MUTATION,
  ADD_SUB_ISSUE_MUTATION,
  ADD_TO_PROJECT_MUTATION,
  ITEM_ID_QUERY,
  LINK_PROJECT_TO_REPO_MUTATION,
  PARENT_QUERY,
  REMOVE_BLOCKED_BY_MUTATION,
  REMOVE_SUB_ISSUE_MUTATION,
  REPO_ID_QUERY,
  UPDATE_FIELD_MUTATION,
} from '../queries'

const GITHUB_API = 'https://api.github.com'
const GRAPHQL_URL = `${GITHUB_API}/graphql`

export class GitHubAdapter implements IssuePort, ProjectPort {
  #token: string | null = null
  #repo: string
  #projectId: string | null

  constructor(repo: string, projectId?: string | null) {
    this.#repo = repo
    this.#projectId = projectId ?? null
  }

  // --- Token management ---

  private getToken(): string {
    if (this.#token) return this.#token

    if (process.env.GITHUB_TOKEN) {
      this.#token = process.env.GITHUB_TOKEN
      return this.#token
    }

    try {
      const proc = Bun.spawnSync(['gh', 'auth', 'token'], { stdout: 'pipe', stderr: 'pipe' })
      const token = new TextDecoder().decode(proc.stdout).trim()
      if (token) {
        this.#token = token
        return this.#token
      }
    } catch {
      // gh not available
    }

    throw new Error('GITHUB_TOKEN env var required (or gh auth login for local dev)')
  }

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.getToken()}`,
      'Content-Type': 'application/json',
      'User-Agent': 'roxabi-skills',
    }
  }

  // --- Shared helpers ---

  async graphql(query: string, variables: Record<string, string | number | boolean>): Promise<unknown> {
    const res = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: this.authHeaders(),
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

  async run(cmd: string[]): Promise<string> {
    const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' })
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    const code = await proc.exited

    if (code !== 0) {
      throw new Error(`Command failed (${code}): ${cmd.join(' ')}\n${stderr}`)
    }
    return stdout.trim()
  }

  // --- IssuePort ---

  async getIssue(number: number): Promise<Issue> {
    const json = await this.run([
      'gh',
      'issue',
      'view',
      String(number),
      '--repo',
      this.#repo,
      '--json',
      'number,title,url,state,labels,assignees',
    ])
    const data = JSON.parse(json) as {
      number: number
      title: string
      url: string
      state: string
      labels: { name: string }[]
      assignees: { login: string }[]
    }
    return {
      number: data.number,
      title: data.title,
      url: data.url,
      state: data.state,
      status: '',
      size: null,
      priority: null,
      labels: data.labels.map((l) => l.name),
      assignees: data.assignees.map((a) => a.login),
      children: [],
    }
  }

  async listIssues(filters?: IssueFilters): Promise<Issue[]> {
    const args = [
      'gh',
      'issue',
      'list',
      '--repo',
      this.#repo,
      '--json',
      'number,title,url,state,labels,assignees',
      '--limit',
      '100',
    ]
    if (filters?.state && filters.state !== 'all') {
      args.push('--state', filters.state === 'OPEN' ? 'open' : 'closed')
    }
    if (filters?.labels?.length) {
      args.push('--label', filters.labels.join(','))
    }
    if (filters?.search) {
      args.push('--search', filters.search)
    }
    const json = await this.run(args)
    const items = JSON.parse(json) as Array<{
      number: number
      title: string
      url: string
      state: string
      labels: { name: string }[]
      assignees: { login: string }[]
    }>
    return items.map((d) => ({
      number: d.number,
      title: d.title,
      url: d.url,
      state: d.state,
      status: '',
      size: null,
      priority: null,
      labels: d.labels.map((l) => l.name),
      assignees: d.assignees.map((a) => a.login),
      children: [],
    }))
  }

  async getNodeId(number: number): Promise<string> {
    const res = await fetch(`${GITHUB_API}/repos/${this.#repo}/issues/${number}`, {
      headers: this.authHeaders(),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Failed to get node ID for #${number} (${res.status}): ${text}`)
    }
    const data = (await res.json()) as { node_id: string }
    return data.node_id
  }

  async createIssue(title: string, body?: string, labels?: string[]): Promise<{ url: string; number: number }> {
    const payload: Record<string, unknown> = { title }
    if (body) payload.body = body
    if (labels?.length) payload.labels = labels

    const res = await fetch(`${GITHUB_API}/repos/${this.#repo}/issues`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Failed to create issue (${res.status}): ${text}`)
    }
    const data = (await res.json()) as { html_url: string; number: number }
    return { url: data.html_url, number: data.number }
  }

  async updateLabels(number: number, add: string[], remove: string[]): Promise<void> {
    const args = ['gh', 'issue', 'edit', String(number), '--repo', this.#repo]
    if (add.length) args.push('--add-label', add.join(','))
    if (remove.length) args.push('--remove-label', remove.join(','))
    await this.run(args)
  }

  async addComment(number: number, body: string): Promise<void> {
    await this.run(['gh', 'issue', 'comment', String(number), '--repo', this.#repo, '--body', body])
  }

  async getParentNumber(number: number): Promise<number | null> {
    const [owner, repo] = this.#repo.split('/')
    const data = (await this.graphql(PARENT_QUERY, { owner, repo, number })) as {
      data: { repository: { issue: { parent: { number: number } | null } } }
    }
    return data.data.repository.issue.parent?.number ?? null
  }

  // --- ProjectPort ---

  private requireProjectId(override?: string): string {
    const pid = override ?? this.#projectId
    if (!pid) throw new Error('GH_PROJECT_ID not configured. Run `/init` or set GH_PROJECT_ID in .env.')
    return pid
  }

  async getItemId(issueNumber: number, overrides?: { projectId?: string; repo?: string }): Promise<string> {
    const pid = this.requireProjectId(overrides?.projectId)
    const repoSlug = overrides?.repo ?? this.#repo
    const [owner, repo] = repoSlug.split('/')
    const data = (await this.graphql(ITEM_ID_QUERY, { owner, repo, number: issueNumber })) as {
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

  async addToProject(nodeId: string, projectId?: string): Promise<string> {
    const pid = this.requireProjectId(projectId)
    const data = (await this.graphql(ADD_TO_PROJECT_MUTATION, {
      projectId: pid,
      contentId: nodeId,
    })) as { data: { addProjectV2ItemById: { item: { id: string } } } }
    return data.data.addProjectV2ItemById.item.id
  }

  async updateField(itemId: string, fieldId: string, optionId: string, projectId?: string): Promise<void> {
    const pid = this.requireProjectId(projectId)
    await this.graphql(UPDATE_FIELD_MUTATION, { projectId: pid, itemId, fieldId, optionId })
  }

  async addBlockedBy(issueId: string, blockingId: string): Promise<void> {
    await this.graphql(ADD_BLOCKED_BY_MUTATION, { issueId, blockingId })
  }

  async removeBlockedBy(issueId: string, blockingId: string): Promise<void> {
    await this.graphql(REMOVE_BLOCKED_BY_MUTATION, { issueId, blockingId })
  }

  async addSubIssue(parentId: string, childId: string): Promise<void> {
    await this.graphql(ADD_SUB_ISSUE_MUTATION, { parentId, childId })
  }

  async removeSubIssue(parentId: string, childId: string): Promise<void> {
    await this.graphql(REMOVE_SUB_ISSUE_MUTATION, { parentId, childId })
  }

  async linkProjectToRepo(projectId: string, owner: string, repoName: string): Promise<void> {
    const repoData = (await this.graphql(REPO_ID_QUERY, { owner, name: repoName })) as {
      data: { repository: { id: string } }
    }
    const repositoryId = repoData.data.repository.id
    await this.graphql(LINK_PROJECT_TO_REPO_MUTATION, { projectId, repositoryId })
  }

  async getBoardIssueNumbers(owner: string, projectNumber: number): Promise<Set<number>> {
    const itemsJson = await this.run([
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
}
