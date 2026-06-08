#!/usr/bin/env bun
import { formatJson, formatTable, formatTree } from '../../skills/issues/lib/table-formatter'
import {
  LANE_LABEL_MAP,
  PRIORITY_LABEL_MAP,
  SIZE_LABEL_MAP,
  STATUS_LABEL_MAP,
} from '../../skills/shared/adapters/config-helpers'
import { getGitHubToken } from '../../skills/shared/adapters/github-adapter'
import type { RawFieldValue, RawItem } from '../../skills/shared/types'
import { resolveCurrentProject, resolveRepoFromCwd } from '../lib/cwd-resolver'
import type { Workspace } from '../lib/workspace-store'
import { readWorkspace } from '../lib/workspace-store'

const REPO_ISSUES_QUERY = `query($owner: String!, $repo: String!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    issues(first: 100, after: $cursor, states: [OPEN], orderBy: {field: CREATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title state url
        labels(first: 20) { nodes { name } }
        subIssues(first: 50) { nodes { number state title } }
        parent { number state }
      }
    }
  }
}`

// Reverse index: label name → { field, value (canonical map key) }
const _labelIndex = new Map<string, { field: string; value: string }>()
for (const [canonical, labelName] of Object.entries(STATUS_LABEL_MAP)) {
  _labelIndex.set(labelName, { field: 'Status', value: canonical })
}
for (const [canonical, labelName] of Object.entries(SIZE_LABEL_MAP)) {
  _labelIndex.set(labelName, { field: 'Size', value: canonical })
}
for (const [canonical, labelName] of Object.entries(PRIORITY_LABEL_MAP)) {
  _labelIndex.set(labelName, { field: 'Priority', value: canonical })
}
for (const [canonical, labelName] of Object.entries(LANE_LABEL_MAP)) {
  _labelIndex.set(labelName, { field: 'Lane', value: canonical })
}

export function labelsToFieldValues(labels: { name: string }[]): RawFieldValue[] {
  return labels
    .map((l) => _labelIndex.get(l.name))
    .filter((e): e is { field: string; value: string } => e !== undefined)
    .map((e) => ({ field: { name: e.field }, name: e.value }))
}

interface RepoIssueNode {
  number: number
  title: string
  state: string
  url: string
  labels?: { nodes: { name: string }[] }
  subIssues?: { nodes: { number: number; state: string; title: string }[] }
  parent?: { number: number; state: string } | null
}

export function repoIssueToRawItem(node: RepoIssueNode): RawItem {
  return {
    content: {
      number: node.number,
      title: node.title,
      state: node.state,
      url: node.url,
      labels: node.labels ?? { nodes: [] },
      subIssues: node.subIssues ?? { nodes: [] },
      parent: node.parent ?? null,
      blockedBy: { nodes: [] },
      blocking: { nodes: [] },
    },
    fieldValues: { nodes: labelsToFieldValues(node.labels?.nodes ?? []) },
  }
}

export interface IssuesCommandOptions {
  workspace?: Workspace
  format?: 'table' | 'tree' | 'json'
  all?: boolean
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

/** Fetch all open issues for a repo with cursor-based pagination. */
async function fetchRepoIssues(repo: string, token: string): Promise<RawItem[]> {
  const [owner, name] = repo.split('/')
  const allItems: RawItem[] = []
  let cursor: string | undefined
  do {
    const variables: Record<string, string> = { owner, repo: name }
    if (cursor) variables.cursor = cursor
    const data = (await ghGraphQL(REPO_ISSUES_QUERY, variables, token)) as {
      data: {
        repository: { issues: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: RepoIssueNode[] } }
      }
    }
    const page = data.data.repository.issues
    allItems.push(...page.nodes.map(repoIssueToRawItem))
    cursor = page.pageInfo.hasNextPage ? (page.pageInfo.endCursor ?? undefined) : undefined
  } while (cursor)
  return allItems
}

/**
 * Testable core of the issues command.
 * Returns formatted output as a string instead of printing to stdout.
 */
export async function runIssuesCommand(opts: IssuesCommandOptions = {}): Promise<string> {
  const ws = opts.workspace ?? readWorkspace()
  if (ws.projects.length === 0) {
    return 'No projects in workspace.\nRun: roxabi workspace add owner/repo'
  }

  const token = getGitHubToken()
  const format = opts.format ?? 'table'
  const formatOpts = { sortBy: 'priority' as const, titleLength: 55 }
  const byProject = new Map<string, RawItem[]>()

  if (!opts.all) {
    // Default: single project matched to cwd
    const cwd = process.cwd()
    const matched = resolveCurrentProject(ws.projects, cwd)
    if (!matched) {
      const slug = resolveRepoFromCwd(cwd)
      const hint = slug
        ? `Detected repo: ${slug} — not registered.\nRun: roxabi workspace add ${slug}`
        : `Run with -A to show all projects, or register this path with: roxabi workspace add owner/repo`
      return `No project found for current directory: ${cwd}\n${hint}`
    }
    const items = await fetchRepoIssues(matched.repo, token)
    byProject.set(matched.label, items)
  } else {
    // -A: fetch all projects sequentially via repo-centric query
    for (const p of ws.projects) {
      byProject.set(p.label, await fetchRepoIssues(p.repo, token))
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
