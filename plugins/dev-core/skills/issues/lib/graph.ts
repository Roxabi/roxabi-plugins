import { escHtml, shortTitle } from './components'
import type { DepNode, GraphDims, Issue } from './types'

export function flattenIssues(issues: Issue[]): Map<number, Issue> {
  const flat = new Map<number, Issue>()
  const collect = (list: Issue[]) => {
    for (const i of list) {
      flat.set(i.number, i)
      collect(i.children)
    }
  }
  collect(issues)
  return flat
}

export function buildDepGraph(issues: Issue[]): DepNode[] {
  // Only include root-level issues in the graph (children deps stay internal to epics)
  const rootNumbers = new Set(issues.map((i) => i.number))

  const nodes: DepNode[] = []
  for (const issue of issues) {
    const targets = issue.blocking
      .filter((b) => b.state === 'OPEN' && rootNumbers.has(b.number))
      .map((b) => b.number)
    if (targets.length > 0) {
      nodes.push({
        number: issue.number,
        title: issue.title,
        blockStatus: issue.blockStatus,
        targets,
      })
    }
  }

  // Topological sort
  const emitted = new Set<number>()
  const sorted: DepNode[] = []
  const remaining = [...nodes]
  while (remaining.length > 0) {
    const ready = remaining.filter((n) =>
      nodes.filter((o) => o.targets.includes(n.number)).every((o) => emitted.has(o.number))
    )
    if (ready.length === 0) {
      sorted.push(...remaining)
      break
    }
    for (const n of ready) {
      sorted.push(n)
      emitted.add(n.number)
      remaining.splice(remaining.indexOf(n), 1)
    }
  }

  return sorted
}

function collectGraphNumbers(nodes: DepNode[]): Set<number> {
  const allNumbers = new Set<number>()
  for (const n of nodes) {
    allNumbers.add(n.number)
    for (const t of n.targets) allNumbers.add(t)
  }
  return allNumbers
}

function bfsAssignLayers(nodes: DepNode[]): Map<number, number> {
  const col = new Map<number, number>()
  const blockedNumbers = new Set(nodes.flatMap((n) => n.targets))
  const sources = nodes.filter((n) => !blockedNumbers.has(n.number))

  const queue = sources.map((n) => n.number)
  for (const num of queue) col.set(num, 0)
  const visited = new Set(queue)

  while (queue.length > 0) {
    const num = queue.shift()
    if (num === undefined) continue
    const node = nodes.find((n) => n.number === num)
    if (!node) continue
    const myCol = col.get(num) ?? 0
    for (const t of node.targets) {
      const existing = col.get(t) ?? 0
      col.set(t, Math.max(existing, myCol + 1))
      if (!visited.has(t)) {
        visited.add(t)
        queue.push(t)
      }
    }
  }

  return col
}

function groupByColumn(col: Map<number, number>, allNumbers: Set<number>): Map<number, number[]> {
  for (const num of allNumbers) {
    if (!col.has(num)) col.set(num, 0)
  }

  const columns = new Map<number, number[]>()
  for (const [num, c] of col) {
    if (!columns.has(c)) columns.set(c, [])
    columns.get(c)?.push(num)
  }

  return columns
}

function computeNodePositions(
  columns: Map<number, number[]>,
  dims: GraphDims,
  svgHeight: number
): Map<number, { x: number; y: number }> {
  const pos = new Map<number, { x: number; y: number }>()
  for (const [c, nums] of columns) {
    const x = 10 + c * (dims.nodeWidth + dims.hGap)
    const totalH = nums.length * dims.nodeHeight + (nums.length - 1) * dims.vGap
    const startY = (svgHeight - totalH) / 2
    nums.forEach((num, i) => {
      pos.set(num, { x, y: startY + i * (dims.nodeHeight + dims.vGap) })
    })
  }
  return pos
}

function renderSvgEdges(
  nodes: DepNode[],
  pos: Map<number, { x: number; y: number }>,
  dims: GraphDims
): string {
  let svg = ''
  for (const node of nodes) {
    const from = pos.get(node.number)
    if (!from) continue
    for (const t of node.targets) {
      const to = pos.get(t)
      if (!to) continue
      const x1 = from.x + dims.nodeWidth
      const y1 = from.y + dims.nodeHeight / 2
      const x2 = to.x
      const y2 = to.y + dims.nodeHeight / 2
      const cx1 = x1 + dims.hGap / 2
      const cx2 = x2 - dims.hGap / 2
      svg += `<path d="M${x1},${y1} C${cx1},${y1} ${cx2},${y2} ${x2},${y2}" fill="none" stroke="#8b949e" stroke-width="1.5" marker-end="url(#arrow)" opacity="0.6"/>`
    }
  }
  return svg
}

const BLOCK_COLOR: Record<string, string> = {
  blocking: '#d29922',
  blocked: '#f85149',
  ready: '#3fb950',
}

function renderSvgNodes(
  allNumbers: Set<number>,
  pos: Map<number, { x: number; y: number }>,
  flat: Map<number, Issue>,
  dims: GraphDims
): string {
  let svg = ''
  for (const num of allNumbers) {
    const p = pos.get(num)
    if (!p) continue
    const issue = flat.get(num)
    const label = issue ? `#${num} ${shortTitle(issue.title, 16)}` : `#${num}`
    const status = issue?.blockStatus ?? 'ready'
    const color = BLOCK_COLOR[status] ?? '#8b949e'

    svg += `<g>`
    svg += `<rect x="${p.x}" y="${p.y}" width="${dims.nodeWidth}" height="${dims.nodeHeight}" rx="4" fill="#161b22" stroke="${color}" stroke-width="1.5"/>`
    svg += `<text x="${p.x + 8}" y="${p.y + dims.nodeHeight / 2 + 4}" fill="#e6edf3" font-size="11" font-family="-apple-system, sans-serif">${escHtml(label)}</text>`
    svg += `</g>`
  }
  return svg
}

export function renderDepGraph(nodes: DepNode[], allIssues: Issue[]): string {
  if (nodes.length === 0) return '<p class="empty-state">No dependency chains</p>'

  const flat = flattenIssues(allIssues)
  const allNumbers = collectGraphNumbers(nodes)

  const dims: GraphDims = { nodeWidth: 140, nodeHeight: 28, hGap: 40, vGap: 16 }
  const col = bfsAssignLayers(nodes)
  const columns = groupByColumn(col, allNumbers)

  const maxCol = Math.max(...columns.keys(), 0)
  const maxRowCount = Math.max(...[...columns.values()].map((v) => v.length), 1)

  const svgWidth = (maxCol + 1) * (dims.nodeWidth + dims.hGap) + 20
  const svgHeight = maxRowCount * (dims.nodeHeight + dims.vGap) + 20

  const pos = computeNodePositions(columns, dims, svgHeight)

  let svg = `<svg width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}" class="dep-graph">`
  svg += `<defs><marker id="arrow" viewBox="0 0 10 6" refX="10" refY="3" markerWidth="8" markerHeight="6" orient="auto"><path d="M0,0 L10,3 L0,6" fill="#8b949e"/></marker></defs>`
  svg += renderSvgEdges(nodes, pos, dims)
  svg += renderSvgNodes(allNumbers, pos, flat, dims)
  svg += `</svg>`
  return svg
}
