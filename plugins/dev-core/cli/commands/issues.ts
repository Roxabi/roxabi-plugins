#!/usr/bin/env bun
import { formatJson, formatTable, formatTree } from '../../skills/issues/lib/table-formatter'
import { buildBatchedQuery, buildBatchedVariables, ISSUES_QUERY } from '../../skills/shared/queries'
import type { RawItem } from '../../skills/shared/types'
import { readWorkspace } from '../lib/workspace'

export interface IssuesCommandProject {
  repo: string
  projectId?: string
  id?: string
  label: string
  localPath?: string
}

export interface IssuesCommandWorkspace {
  projects: IssuesCommandProject[]
}

export interface IssuesCommandOptions {
  workspace?: IssuesCommandWorkspace
  format?: 'table' | 'tree' | 'json'
  all?: boolean
}

function resolveToken(): string {
  const token =
    process.env.GITHUB_TOKEN ||
    (() => {
      const proc = Bun.spawnSync(['gh', 'auth', 'token'], { stdout: 'pipe', stderr: 'pipe' })
      return new TextDecoder().decode(proc.stdout).trim()
    })()
  if (!token) throw new Error('Not authenticated. Run: gh auth login or set GITHUB_TOKEN env var')
  return token
}

async function ghGraphQL(query: string, variables: Record<string, string>, token: string): Promise<unknown> {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'roxabi-cli' },
    body: JSON.stringify({ query, variables }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`GitHub GraphQL error (${res.status}): ${text}`)
  }
  return res.json()
}

/** Fetch all items for a single project with full cursor-based pagination (no 100-item cap). */
async function fetchProjectItems(projectId: string, token: string): Promise<RawItem[]> {
  const allItems: RawItem[] = []
  let cursor: string | undefined
  do {
    const variables: Record<string, string> = { projectId }
    if (cursor) variables.cursor = cursor
    const data = (await ghGraphQL(ISSUES_QUERY, variables, token)) as {
      data: { node: { items: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: RawItem[] } } }
    }
    const page = data.data.node.items
    allItems.push(...page.nodes)
    cursor = page.pageInfo.hasNextPage ? (page.pageInfo.endCursor ?? undefined) : undefined
  } while (cursor)
  return allItems
}

/** Match cwd against localPath entries in workspace. Returns the first match or null. */
function resolveCurrentProject(projects: IssuesCommandProject[], cwd: string): IssuesCommandProject | null {
  // Exact match first, then prefix match (cwd is inside localPath)
  return (
    projects.find((p) => p.localPath && cwd === p.localPath) ??
    projects.find((p) => p.localPath && cwd.startsWith(`${p.localPath}/`)) ??
    null
  )
}

/**
 * Testable core of the issues command.
 * Returns formatted output as a string instead of printing to stdout.
 */
export async function runIssuesCommand(opts: IssuesCommandOptions = {}): Promise<string> {
  const ws = opts.workspace ?? (readWorkspace() as IssuesCommandWorkspace)
  if (ws.projects.length === 0) {
    return 'No projects in workspace.\nRun: roxabi workspace add owner/repo'
  }

  const token = resolveToken()
  const format = opts.format ?? 'table'
  const formatOpts = { sortBy: 'priority' as const, titleLength: 55 }
  const byProject = new Map<string, RawItem[]>()

  if (!opts.all) {
    // Default: single project matched to cwd
    const cwd = process.cwd()
    const matched = resolveCurrentProject(ws.projects, cwd)
    if (!matched) {
      return (
        `No project found for current directory: ${cwd}\n` +
        `Run with -A to show all projects, or register this path with: roxabi workspace add owner/repo`
      )
    }
    const projectId = matched.projectId ?? matched.id ?? ''
    const items = await fetchProjectItems(projectId, token)
    byProject.set(matched.label, items)
  } else {
    // -A: all projects via batched query (100-item cap per project)
    const projectIds = ws.projects.map((p) => p.projectId ?? p.id ?? '')
    const query = buildBatchedQuery(projectIds)
    const variables = buildBatchedVariables(projectIds)
    const json = (await ghGraphQL(query, variables, token)) as {
      data: Record<string, { items: { nodes: RawItem[] } } | null>
    }
    for (let i = 0; i < ws.projects.length; i++) {
      const node = json.data[`project${i}`]
      byProject.set(ws.projects[i].label, node?.items?.nodes ?? [])
    }
  }

  if (format === 'json') {
    const allItems: RawItem[] = []
    for (const items of byProject.values()) allItems.push(...items)
    return formatJson(allItems)
  }

  const lines: string[] = []

  for (const [label, items] of byProject) {
    lines.push(`\n## ${label}`)
    const open = items.filter((i) => i.content?.state === 'OPEN')
    if (open.length === 0) {
      lines.push('  0 issues')
      continue
    }
    lines.push(format === 'tree' ? formatTree(items, formatOpts) : formatTable(items, formatOpts))
  }

  return lines.join('\n')
}

export async function run(args: string[]): Promise<void> {
  let format: 'table' | 'tree' | 'json' = 'table'
  let all = false
  for (const arg of args) {
    if (arg === '--tree' || arg === '-T') format = 'tree'
    else if (arg === '--json') format = 'json'
    else if (arg === '--all' || arg === '-A') all = true
  }

  const output = await runIssuesCommand({ format, all })
  console.log(output)
}
