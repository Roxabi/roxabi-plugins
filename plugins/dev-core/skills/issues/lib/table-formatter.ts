/**
 * Pure formatting functions for CLI table output.
 * Ports the jq logic from the old fetch_issues.sh.
 */

import {
  BLOCK_ORDER,
  PRIORITY_ORDER,
  PRIORITY_SHORT,
  SIZE_ORDER,
  STATUS_ORDER,
  STATUS_SHORT,
} from '../../shared/config'
import type { RawItem } from '../../shared/types'
import type { Issue } from './types'

export function pad(s: string, width: number): string {
  if (s.length >= width) return s.slice(0, width)
  return s + ' '.repeat(width - s.length)
}

function blockIcon(status: string): string {
  if (status === 'blocked') return '\u26D4'
  if (status === 'blocking') return '\uD83D\uDD13'
  return '\u2705'
}

export function formatDeps(issue: Issue): string {
  const parts: string[] = []
  for (const b of issue.blockedBy) {
    parts.push(b.state === 'OPEN' ? `\u26D4#${b.number}` : `\u2705#${b.number}`)
  }
  for (const b of issue.blocking) {
    parts.push(`\uD83D\uDD13#${b.number}`)
  }
  return parts.length > 0 ? parts.join(' ') : '-'
}

function shortTitle(title: string, maxLen: number): string {
  if (title.length > maxLen) return `${title.slice(0, maxLen - 3)}...`
  return title
}

function formatChildRow(
  sub: { number: number; state: string; title: string },
  childItem: RawItem | undefined,
  prefix: string,
  titleLen: number
): string {
  const numStr = `#${sub.number}`
  const prefixLen = numStr.length + 7 // "       │   " + prefix + "#NN "
  const cTitleWidth = titleLen + 3 - prefixLen

  if (childItem) {
    const cStatus = fieldValue(childItem, 'Status')
    const cSize = fieldValue(childItem, 'Size')
    const cPri = fieldValue(childItem, 'Priority')
    const cBlock = computeBlockStatus(childItem)
    const cDeps = formatDepsFromRaw(childItem)
    const cTitle =
      shortTitle(childItem.content.title, cTitleWidth - 4) +
      (childItem.content.title.length > cTitleWidth - 4 ? '' : '')
    const cTitlePadded = pad(cTitle, cTitleWidth)

    return `       \u2502   ${prefix}${numStr} ${cTitlePadded}\u2502 ${pad(STATUS_SHORT[cStatus] ?? cStatus, 9)}\u2502 ${pad(cSize, 5)}\u2502 ${pad(PRIORITY_SHORT[cPri] ?? cPri, 4)}\u2502 ${blockIcon(cBlock)} \u2502 ${cDeps}`
  }

  // Closed child — show with Done status
  const cTitle = shortTitle(sub.title || '?', cTitleWidth - 4)
  const cTitlePadded = pad(cTitle, cTitleWidth)
  return `       \u2502   ${prefix}${numStr} ${cTitlePadded}\u2502 ${pad('Done', 9)}\u2502 ${pad('-', 5)}\u2502 ${pad('-', 4)}\u2502   \u2502`
}

function fieldValue(item: RawItem, name: string): string {
  for (const fv of item.fieldValues.nodes) {
    if (fv.field?.name === name && fv.name) return fv.name
  }
  return '-'
}

function computeBlockStatus(item: RawItem): string {
  const bb = item.content.blockedBy?.nodes ?? []
  const bl = item.content.blocking?.nodes ?? []
  const openBlockedBy = bb.filter((b) => b.state === 'OPEN')
  if (openBlockedBy.length > 0) return 'blocked'
  if (bl.length > 0) return 'blocking'
  return 'ready'
}

function formatDepsFromRaw(item: RawItem): string {
  const parts: string[] = []
  for (const b of item.content.blockedBy?.nodes ?? []) {
    parts.push(b.state === 'OPEN' ? `\u26D4#${b.number}` : `\u2705#${b.number}`)
  }
  for (const b of item.content.blocking?.nodes ?? []) {
    parts.push(`\uD83D\uDD13#${b.number}`)
  }
  return parts.length > 0 ? parts.join(' ') : '-'
}

export interface FormatOptions {
  sortBy: 'priority' | 'size'
  titleLength: number
}

export function sortIssues(items: RawItem[]): RawItem[] {
  return [...items].sort((a, b) => {
    const aStatus = fieldValue(a, 'Status')
    const bStatus = fieldValue(b, 'Status')
    const sd = (STATUS_ORDER[aStatus] ?? 99) - (STATUS_ORDER[bStatus] ?? 99)
    if (sd !== 0) return sd

    const aBlock = computeBlockStatus(a)
    const bBlock = computeBlockStatus(b)
    const bd = (BLOCK_ORDER[aBlock] ?? 9) - (BLOCK_ORDER[bBlock] ?? 9)
    if (bd !== 0) return bd

    const aPri = fieldValue(a, 'Priority')
    const bPri = fieldValue(b, 'Priority')
    const pd = (PRIORITY_ORDER[aPri] ?? 99) - (PRIORITY_ORDER[bPri] ?? 99)
    if (pd !== 0) return pd

    const aSize = fieldValue(a, 'Size')
    const bSize = fieldValue(b, 'Size')
    return (SIZE_ORDER[aSize] ?? 99) - (SIZE_ORDER[bSize] ?? 99)
  })
}

/** Format a complete table from raw items (matching old fetch_issues.sh output). */
export function formatTable(allItems: RawItem[], opts: FormatOptions): string {
  const openItems = allItems.filter((i) => i.content?.state === 'OPEN')
  const byNum = new Map<number, RawItem>()
  for (const item of openItems) byNum.set(item.content.number, item)

  // Root issues: no open parent
  const roots = openItems.filter((i) => !i.content.parent || i.content.parent.state === 'CLOSED')

  const sorted = sortIssues(roots)
  const tl = opts.titleLength

  const lines: string[] = []
  lines.push(`\u25CF ${sorted.length} issues`)
  lines.push('')
  lines.push(
    `  ${pad('#', 5)}\u2502 ${pad('Title', tl + 2)}\u2502 ${pad('Status', 9)}\u2502 ${pad('Size', 5)}\u2502 ${pad('Pri', 4)}\u2502 \u26A1 \u2502 Deps`
  )

  for (const item of sorted) {
    const status = fieldValue(item, 'Status')
    const size = fieldValue(item, 'Size')
    const priority = fieldValue(item, 'Priority')
    const num = item.content.number
    const title = shortTitle(item.content.title, tl)
    const bStatus = computeBlockStatus(item)
    const deps = formatDepsFromRaw(item)

    lines.push(
      `  ${pad(`#${num}`, 5)}\u2502 ${pad(title, tl + 2)}\u2502 ${pad(STATUS_SHORT[status] ?? status, 9)}\u2502 ${pad(size, 5)}\u2502 ${pad(PRIORITY_SHORT[priority] ?? priority, 4)}\u2502 ${blockIcon(bStatus)} \u2502 ${deps}`
    )

    // Children
    const subs = item.content.subIssues?.nodes ?? []
    if (subs.length > 0) {
      for (let i = 0; i < subs.length; i++) {
        const isLast = i === subs.length - 1
        const prefix = isLast ? '\u2514 ' : '\u251C '
        const childItem = byNum.get(subs[i].number)
        lines.push(formatChildRow(subs[i], childItem, prefix, tl))
      }
    }
  }

  lines.push('')
  lines.push('  \u26D4=blocked  \uD83D\uDD13=blocking  \u2705=ready')
  lines.push('')

  // Dependency chains
  const chains = buildChains(openItems)
  if (chains.length > 0) {
    lines.push('  Chains:')
    lines.push(...chains)
  }

  return lines.join('\n')
}

function shortName(title: string): string {
  let s = title
    .replace(/^(feat|chore|docs|fix|refactor)\(.*?\):\s*/i, '')
    .replace(/^Feature:\s*/i, '')
    .replace(/^LATER:\s*/i, '')
    .replace(/\s*\(.*?\)$/, '')
  if (s.length > 20) s = `${s.slice(0, 17)}...`
  return s
}

type GraphNode = { num: number; title: string; blocks: number[] }

function buildDependencyGraph(allItems: RawItem[]): Map<number, GraphNode> {
  const graph = new Map<number, GraphNode>()
  for (const item of allItems) {
    const blocks = (item.content.blocking?.nodes ?? [])
      .filter((b) => b.state === 'OPEN')
      .map((b) => b.number)
      .sort()
    graph.set(item.content.number, {
      num: item.content.number,
      title: item.content.title,
      blocks: [...new Set(blocks)],
    })
  }
  return graph
}

function topologicalSort(blockers: number[], graph: Map<number, GraphNode>): number[] {
  const inDeps = new Map<number, number[]>()
  for (const num of blockers) {
    const upstream = blockers.filter(
      (other) => other !== num && (graph.get(other)?.blocks.includes(num) ?? false)
    )
    inDeps.set(num, upstream)
  }

  const emitted: number[] = []
  let remaining = [...blockers]
  while (remaining.length > 0) {
    const emittedSet = new Set(emitted)
    const ready = remaining
      .filter((num) => (inDeps.get(num) ?? []).every((d) => emittedSet.has(d)))
      .sort()
    if (ready.length === 0) {
      emitted.push(...remaining.sort())
      remaining = []
    } else {
      emitted.push(...ready)
      remaining = remaining.filter((n) => !ready.includes(n))
    }
  }
  return emitted
}

function formatChainLines(emitted: number[], graph: Map<number, GraphNode>): string[] {
  const lines: string[] = []
  for (const num of emitted) {
    const node = graph.get(num)
    if (!node) continue
    const [first, ...rest] = node.blocks
    const firstNode = graph.get(first)
    lines.push(
      `  #${num} ${shortName(node.title)} \u2500\u2500\u25BA #${first} ${shortName(firstNode?.title ?? '')}`
    )
    for (const t of rest) {
      const targetNode = graph.get(t)
      lines.push(
        `                               \u2514\u2500\u2500\u25BA #${t} ${shortName(targetNode?.title ?? '')}`
      )
    }
  }
  return lines
}

function buildChains(allItems: RawItem[]): string[] {
  const graph = buildDependencyGraph(allItems)

  const blockers = [...graph.values()]
    .filter((n) => n.blocks.length > 0)
    .map((n) => n.num)
    .sort()
  if (blockers.length === 0) return []

  const emitted = topologicalSort(blockers, graph)
  return formatChainLines(emitted, graph)
}

/** Format raw items as JSON (matching old fetch_issues.sh --json output). */
export function formatJson(allItems: RawItem[]): string {
  const openItems = allItems.filter((i) => i.content?.state === 'OPEN')

  const result = openItems.map((item) => {
    const bb = item.content.blockedBy?.nodes ?? []
    const bl = item.content.blocking?.nodes ?? []

    return {
      number: item.content.number,
      title: item.content.title,
      status: fieldValue(item, 'Status'),
      size: fieldValue(item, 'Size'),
      priority: fieldValue(item, 'Priority'),
      blocked_by: bb.map((b) => ({ number: b.number, state: b.state })),
      blocked_by_open: bb.filter((b) => b.state === 'OPEN').map((b) => b.number),
      blocked_by_closed: bb.filter((b) => b.state === 'CLOSED').map((b) => b.number),
      blocks: bl.map((b) => ({ number: b.number, state: b.state })),
      sub_issues: item.content.subIssues?.nodes ?? [],
      parent_issue: item.content.parent ?? null,
    }
  })

  return JSON.stringify(result, null, 2)
}
