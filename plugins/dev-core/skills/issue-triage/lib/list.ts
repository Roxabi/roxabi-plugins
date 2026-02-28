/**
 * List untriaged issues (missing Size or Priority).
 * Replaces list.sh.
 */

import { PROJECT_ID } from '../../shared/config'
import { ghGraphQL } from '../../shared/github'
import { TRIAGE_QUERY } from '../../shared/queries'
import type { RawItem } from '../../shared/types'

async function fetchAllItems(): Promise<RawItem[]> {
  const allItems: RawItem[] = []
  let cursor: string | undefined

  do {
    const variables: Record<string, string> = { projectId: PROJECT_ID }
    if (cursor) variables.cursor = cursor

    const data = (await ghGraphQL(TRIAGE_QUERY, variables)) as {
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

export async function listIssues(args: string[]): Promise<void> {
  const jsonOutput = args.includes('--json')
  const allItems = await fetchAllItems()

  const openItems = allItems.filter((i) => i.content?.state === 'OPEN')

  const untriaged = openItems
    .map((item) => ({
      item_id: item.id,
      number: item.content.number,
      title: item.content.title,
      size: fieldValue(item, 'Size'),
      priority: fieldValue(item, 'Priority'),
    }))
    .filter((i) => i.size === null || i.priority === null)

  if (jsonOutput) {
    console.log(JSON.stringify(untriaged, null, 2))
    return
  }

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
}
