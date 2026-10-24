/**
 * List open repository issues as a parent-child tree (labels + native sub-issues).
 * --untriaged: flat table of issues missing Size or Priority.
 * --json:      JSON output (combinable with --untriaged).
 */

import {
  GITHUB_REPO,
  PRIORITY_LABEL_MAP,
  PRIORITY_LABELS_SET,
  PRIORITY_SHORT,
  SIZE_LABEL_MAP,
  SIZE_LABELS_SET,
} from '../../shared/adapters/config-helpers'
import { ghGraphQL } from '../../shared/adapters/github-adapter'
import { LIST_ISSUES_QUERY } from '../../shared/queries'

interface GhIssueNode {
  number: number
  title: string
  state: string
  labels?: { nodes: { name: string }[] }
  parent?: { number: number } | null
  subIssues?: { nodes: { number: number; state: string; title: string }[] }
}

export interface IssueRow {
  number: number
  title: string
  size: string | null
  priority: string | null
  subIssueNumbers: number[]
  hasDoneChild: boolean
}

const LABEL_TO_SIZE: Record<string, string> = Object.fromEntries(
  Object.entries(SIZE_LABEL_MAP).map(([canonical, label]) => [label, canonical]),
)

const LABEL_TO_PRIORITY: Record<string, string> = Object.fromEntries(
  Object.entries(PRIORITY_LABEL_MAP).map(([canonical, label]) => [label, canonical]),
)

function sizeFromLabels(labels: { name: string }[]): string | null {
  for (const { name } of labels) {
    if (SIZE_LABELS_SET.has(name)) return LABEL_TO_SIZE[name] ?? null
    if (name.startsWith('size:')) return name.slice('size:'.length)
  }
  return null
}

function priorityFromLabels(labels: { name: string }[]): string | null {
  for (const { name } of labels) {
    if (!PRIORITY_LABELS_SET.has(name)) continue
    const canonical = LABEL_TO_PRIORITY[name]
    if (!canonical) return name
    return PRIORITY_SHORT[canonical] ?? name
  }
  return null
}

async function fetchAllIssues(): Promise<GhIssueNode[]> {
  const [owner, name] = GITHUB_REPO.split('/')
  const all: GhIssueNode[] = []
  let cursor: string | null = null
  let prevCursor: string | null = null
  const maxPages = 50

  for (let pageNum = 0; pageNum < maxPages; pageNum++) {
    const data = (await ghGraphQL(LIST_ISSUES_QUERY, { owner, name, cursor })) as {
      data: {
        repository: {
          issues: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null }
            nodes: GhIssueNode[]
          }
        }
      }
    }

    const page = data.data.repository.issues
    all.push(...page.nodes)
    if (!page.pageInfo.hasNextPage) break
    const next = page.pageInfo.endCursor
    if (!next || next === prevCursor) break
    prevCursor = cursor
    cursor = next
  }

  return all
}

function buildRows(nodes: GhIssueNode[]): IssueRow[] {
  return nodes.map((node) => {
    const labels = node.labels?.nodes ?? []
    const subIssues = node.subIssues?.nodes ?? []
    return {
      number: node.number,
      title: node.title,
      size: sizeFromLabels(labels),
      priority: priorityFromLabels(labels),
      subIssueNumbers: subIssues.map((s) => s.number),
      hasDoneChild: subIssues.some((s) => s.state === 'CLOSED'),
    }
  })
}

export function renderTree(
  roots: IssueRow[],
  byNumber: Map<number, IssueRow>,
  depth: number,
  lines: string[],
  visited: Set<number>,
): void {
  const indent = '  '.repeat(depth)
  for (const row of roots) {
    if (visited.has(row.number)) continue
    visited.add(row.number)

    const maxLen = Math.max(20, 50 - depth * 2)
    const title = row.title.length > maxLen ? `${row.title.slice(0, maxLen - 3)}...` : row.title
    const size = row.size ?? '-'
    const pri = row.priority ?? '-'
    const doneHint = row.hasDoneChild ? '  \u2026 \u2713 Done' : ''
    lines.push(`${indent}#${row.number}  ${title}  [${size}][${pri}]${doneHint}`)

    const children = row.subIssueNumbers.map((n) => byNumber.get(n)).filter((c): c is IssueRow => c !== undefined)
    if (children.length > 0) {
      renderTree(children, byNumber, depth + 1, lines, visited)
    }
  }
}

export async function listIssues(args: string[]): Promise<void> {
  const jsonOutput = args.includes('--json')
  const untriagedOnly = args.includes('--untriaged')
  const nodes = await fetchAllIssues()
  const rows = buildRows(nodes)
  const byNumber = new Map(rows.map((r) => [r.number, r]))

  if (jsonOutput) {
    const output = untriagedOnly ? rows.filter((r) => r.size === null || r.priority === null) : rows
    console.log(JSON.stringify(output, null, 2))
    return
  }

  if (untriagedOnly) {
    const untriaged = rows.filter((r) => r.size === null || r.priority === null)
    if (untriaged.length === 0) {
      console.log('All issues triaged.')
      return
    }
    console.log('| # | Title | Size | Pri |')
    console.log('|---|-------|------|-----|')
    for (const issue of untriaged) {
      const title = issue.title.length > 45 ? `${issue.title.slice(0, 42)}...` : issue.title
      console.log(`| #${issue.number} | ${title} | ${issue.size ?? '-'} | ${issue.priority ?? '-'} |`)
    }
    console.log('')
    console.log(`*${untriaged.length} to triage*`)
    return
  }

  if (rows.length === 0) {
    console.log('No open issues.')
    return
  }

  const allChildNumbers = new Set(rows.flatMap((r) => r.subIssueNumbers))
  let roots = rows.filter((r) => !allChildNumbers.has(r.number))
  if (roots.length === 0) roots = rows

  const lines: string[] = []
  renderTree(roots, byNumber, 0, lines, new Set())
  for (const line of lines) console.log(line)
  console.log('')
  console.log(`*${rows.length} open issue${rows.length === 1 ? '' : 's'}*`)
}
