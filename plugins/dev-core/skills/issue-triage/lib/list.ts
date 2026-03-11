/**
 * List all open issues as a parent-child tree.
 * --untriaged: flat table of issues missing Size or Priority (original behavior).
 * --json:      JSON output.
 */

import { GH_PROJECT_ID, PRIORITY_LABEL_MAP, PRIORITY_LABELS_SET } from '../../shared/adapters/config-helpers'
import { ghGraphQL } from '../../shared/adapters/github-adapter'
import { LIST_QUERY } from '../../shared/queries'
import type { RawItem } from '../../shared/types'

async function fetchAllItems(): Promise<RawItem[]> {
  const allItems: RawItem[] = []
  let cursor: string | undefined

  do {
    const variables: Record<string, string> = { projectId: GH_PROJECT_ID }
    if (cursor) variables.cursor = cursor

    const data = (await ghGraphQL(LIST_QUERY, variables)) as {
      data: {
        node: {
          items: {
            pageInfo: { hasNextPage: boolean; endCursor: string }
            nodes: RawItem[]
          }
        }
      }
    }

    allItems.push(...data.data.node.items.nodes)
    const pageInfo = data.data.node.items.pageInfo
    cursor = pageInfo.hasNextPage ? (pageInfo.endCursor ?? undefined) : undefined
  } while (cursor)

  return allItems
}

function fieldValue(item: RawItem, name: string): string | null {
  for (const fv of item.fieldValues.nodes) {
    if (fv.field?.name === name && fv.name) return fv.name
  }
  return null
}

// Reverse map: label name → canonical priority
const LABEL_TO_PRIORITY: Record<string, string> = Object.fromEntries(
  Object.entries(PRIORITY_LABEL_MAP).map(([canonical, label]) => [label, canonical]),
)

/** Detect mismatch between project Priority field and issue labels. */
export function detectPriorityMismatch(item: RawItem): boolean {
  const fieldPriority = fieldValue(item, 'Priority')
  const labels = item.content.labels?.nodes ?? []
  const priorityLabel = labels.find((l) => PRIORITY_LABELS_SET.has(l.name))

  if (!fieldPriority && !priorityLabel) return false
  if (!fieldPriority || !priorityLabel) return true

  const labelCanonical = LABEL_TO_PRIORITY[priorityLabel.name]
  return fieldPriority !== labelCanonical
}

interface IssueRow {
  item_id: string | undefined
  number: number
  title: string
  size: string | null
  priority: string | null
  status: string | null
  mismatch: boolean
  subIssueNumbers: number[]
  hasDoneChild: boolean
}

function buildRows(items: RawItem[]): IssueRow[] {
  return items.map((item) => {
    const subIssues = item.content.subIssues?.nodes ?? []
    return {
      item_id: item.id,
      number: item.content.number,
      title: item.content.title,
      size: fieldValue(item, 'Size'),
      priority: fieldValue(item, 'Priority'),
      status: fieldValue(item, 'Status'),
      mismatch: detectPriorityMismatch(item),
      subIssueNumbers: subIssues.map((s) => s.number),
      hasDoneChild: subIssues.some((s) => s.state === 'CLOSED'),
    }
  })
}

function renderTree(roots: IssueRow[], byNumber: Map<number, IssueRow>, depth: number, lines: string[]): void {
  const indent = '  '.repeat(depth)
  for (const row of roots) {
    const maxLen = Math.max(20, 50 - depth * 2)
    const title = row.title.length > maxLen ? `${row.title.slice(0, maxLen - 3)}...` : row.title
    const size = row.size ?? '-'
    const pri = row.priority ?? '-'
    const status = row.status ?? '-'
    const mismatch = row.mismatch ? ' \u26a0' : ''
    const doneHint = row.hasDoneChild ? '  \u2026 \u2713 Done' : ''
    lines.push(`${indent}#${row.number}  ${title}  [${size}][${pri}${mismatch}][${status}]${doneHint}`)

    const children = row.subIssueNumbers.map((n) => byNumber.get(n)).filter((c): c is IssueRow => c !== undefined)
    if (children.length > 0) {
      renderTree(children, byNumber, depth + 1, lines)
    }
  }
}

export async function listIssues(args: string[]): Promise<void> {
  const jsonOutput = args.includes('--json')
  const untriagedOnly = args.includes('--untriaged')
  const allItems = await fetchAllItems()

  const openItems = allItems.filter((i) => i.content?.state === 'OPEN')
  const rows = buildRows(openItems)
  const byNumber = new Map(rows.map((r) => [r.number, r]))

  if (jsonOutput) {
    const output = untriagedOnly ? rows.filter((r) => r.size === null || r.priority === null) : rows
    console.log(JSON.stringify(output, null, 2))
    return
  }

  // --untriaged: flat table of issues missing Size or Priority
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
      const priDisplay = `${issue.priority ?? '-'}${issue.mismatch ? ' \u26a0' : ''}`
      console.log(`| #${issue.number} | ${title} | ${issue.size ?? '-'} | ${priDisplay} |`)
    }
    console.log('')
    console.log(`*${untriaged.length} to triage*`)
    return
  }

  // Default: tree of all open issues
  if (openItems.length === 0) {
    console.log('No open issues.')
    return
  }

  // Roots: issues not referenced as a child by any other issue in our set
  const allChildNumbers = new Set(rows.flatMap((r) => r.subIssueNumbers))
  const roots = rows.filter((r) => !allChildNumbers.has(r.number))

  const lines: string[] = []
  renderTree(roots, byNumber, 0, lines)
  for (const line of lines) console.log(line)
  console.log('')
  console.log(`*${openItems.length} open issue${openItems.length === 1 ? '' : 's'}*`)
}
