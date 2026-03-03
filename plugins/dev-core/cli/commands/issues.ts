#!/usr/bin/env bun
import { buildBatchedQuery, buildBatchedVariables } from '../../skills/shared/queries'
import type { RawItem } from '../../skills/shared/types'
import { readWorkspace } from '../lib/workspace'

export interface IssuesCommandProject {
  repo: string
  projectId?: string
  id?: string
  label: string
}

export interface IssuesCommandWorkspace {
  projects: IssuesCommandProject[]
}

export interface IssuesCommandOptions {
  workspace?: IssuesCommandWorkspace
  format?: 'table' | 'json'
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

  // Normalise: accept either `projectId` or `id` field
  const projectIds = ws.projects.map((p) => p.projectId ?? p.id ?? '')
  const query = buildBatchedQuery(projectIds)
  const variables = buildBatchedVariables(projectIds)

  const token = process.env.GITHUB_TOKEN ?? ''
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'roxabi-cli',
    },
    body: JSON.stringify({ query, variables }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`GitHub GraphQL error (${res.status}): ${text}`)
  }

  const json = (await res.json()) as { data: Record<string, { items: { nodes: RawItem[] } } | null> }

  // Build a map of label → items
  const byProject = new Map<string, RawItem[]>()
  for (let i = 0; i < ws.projects.length; i++) {
    const node = json.data[`project${i}`]
    byProject.set(ws.projects[i].label, node?.items?.nodes ?? [])
  }

  const lines: string[] = []

  for (const [label, items] of byProject) {
    const open = items.filter((i) => i.content?.state === 'OPEN')
    if (open.length === 0) {
      lines.push(`\n## ${label}\n  0 issues`)
      continue
    }
    lines.push(`\n## ${label}`)
    lines.push(`${'#'.padEnd(6)} ${'Title'.padEnd(60)} ${'Status'.padEnd(14)} ${'Size'.padEnd(6)} Project`)
    lines.push('-'.repeat(100))
    for (const item of open) {
      const field = (name: string) => {
        for (const fv of item.fieldValues.nodes) {
          if (fv.field?.name === name && fv.name) return fv.name
        }
        return '-'
      }
      const num = `#${item.content.number}`.padEnd(6)
      const title = (item.content.title ?? '').slice(0, 58).padEnd(60)
      const status = field('Status').padEnd(14)
      const size = field('Size').padEnd(6)
      lines.push(`${num} ${title} ${status} ${size} ${label}`)
    }
  }

  return lines.join('\n')
}

export async function run(_args: string[]): Promise<void> {
  if (!process.env.GITHUB_TOKEN) {
    throw new Error('GITHUB_TOKEN is not set. Export it or run: gh auth login')
  }
  const output = await runIssuesCommand()
  console.log(output)
}
