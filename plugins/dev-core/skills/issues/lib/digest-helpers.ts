/**
 * Pure helper functions for the digest view.
 * Extracted from digest.ts so they can be imported and tested independently.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Leaf {
  number: number
  title: string
  state: 'OPEN' | 'CLOSED'
  blockedBy: number[]
}

export interface EpicData {
  number: number
  title: string
  state: 'OPEN' | 'CLOSED'
  blockedBy: number[]
  leaves: Leaf[]
  subEpics: number[]
  rawSubEpics: unknown[]
}

export interface EpicRow {
  number: number
  title: string
  state: 'OPEN' | 'CLOSED'
  progress: { closed: number; total: number }
  depth: number
  data: EpicData
}

export type LTask = { num: number; title: string; blockedBy: number[] }

// ─── Parsing ──────────────────────────────────────────────────────────────────

export function parseBlockedBy(body: string | null): number[] {
  if (!body) return []
  const nums: number[] = []
  let inSection = false
  for (const line of body.split('\n')) {
    if (/^##\s+blocked by/i.test(line)) {
      inSection = true
      continue
    }
    if (inSection && /^##/.test(line)) break
    if (inSection) {
      for (const m of line.matchAll(/#(\d+)/g)) nums.push(parseInt(m[1], 10))
    }
  }
  return nums
}

// ─── Formatting ───────────────────────────────────────────────────────────────

export function progressBar(closed: number, total: number): string {
  if (total === 0) return '░░░░░'
  const filled = Math.round((closed / total) * 5)
  return '█'.repeat(filled) + '░'.repeat(5 - filled)
}

export function pad(s: string, n: number, align: 'l' | 'r' | 'c' = 'l'): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI escape codes
  const vis = s.replace(/\x1b\[[0-9;]*m/g, '').length
  if (vis >= n) return s
  const gap = n - vis
  if (align === 'r') return ' '.repeat(gap) + s
  if (align === 'c') {
    const l = Math.floor(gap / 2)
    return ' '.repeat(l) + s + ' '.repeat(gap - l)
  }
  return s + ' '.repeat(gap)
}

export function trunc(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`
}

export function stripType(title: string): string {
  return title
    .replace(/^(feat|fix|chore|refactor|docs|test|ops|style)\([^)]+\):\s*/i, '')
    .replace(/^(feat|fix|chore|refactor|docs|test|ops|style):\s*/i, '')
}

export function lane(title: string): 'A' | 'B' | 'C' {
  const t = title.toLowerCase()
  if (/brand|lora|v23|v24|avatar|pulid/.test(t)) return 'C'
  if (/infra|nats|security|ops\(infra|ops\(sec|quadlet|podman|docker|supervisor|\bci\b|provision/.test(t)) return 'A'
  return 'B'
}

export function isActive(r: EpicRow): boolean {
  return r.progress.closed > 0
}

export function openCount(row: EpicRow): number {
  return row.data.leaves.filter((l) => l.state === 'OPEN').length
}

export function nextIssue(row: EpicRow): string {
  const open = row.data.leaves.filter((l) => l.state === 'OPEN')
  if (open.length === 0) return '✓ done'
  const unblocked = open.filter((l) => l.blockedBy.length === 0)
  const pick = unblocked[0] ?? open[0]
  return `#${pick.number} ${trunc(stripType(pick.title), 24)}`
}

// ─── Table layout ─────────────────────────────────────────────────────────────

export const COL = { num: 8, epic: 52, prog: 11, open: 4, next: 26 }
export const SEP = ' │ '

export function trow(num: string, epic: string, prog: string, open: string, next: string): string {
  return `${pad(num, COL.num)}${SEP}${pad(epic, COL.epic)}${SEP}${pad(prog, COL.prog)}${SEP}${pad(open, COL.open, 'r')}${SEP}${pad(next, COL.next)}`
}

// ─── Lane layout ──────────────────────────────────────────────────────────────

export function buildCols(
  leafMap: Map<number, { title: string; blockedBy: number[] }>,
  nums: Set<number>,
  prevNums?: Set<number>,
): Record<'A' | 'B' | 'C', Array<{ label: string; chained: boolean }>> {
  const cols: Record<'A' | 'B' | 'C', Array<{ label: string; chained: boolean }>> = { A: [], B: [], C: [] }
  for (const [num, v] of leafMap) {
    if (!nums.has(num)) continue
    const l = lane(v.title)
    const chained = !!prevNums && v.blockedBy.some((b) => prevNums.has(b))
    const short = trunc(stripType(v.title), 34)
    cols[l].push({ label: `#${num} ${short}`, chained })
  }
  return cols
}

export function renderCols(
  label: string,
  cols: Record<'A' | 'B' | 'C', Array<{ label: string; chained: boolean }>>,
  widths: { A: number; B: number; C: number } = { A: 38, B: 38, C: 34 },
): string[] {
  const max = Math.max(cols.A.length, cols.B.length, cols.C.length)
  if (max === 0) return []
  const out: string[] = []
  for (let i = 0; i < max; i++) {
    const a = cols.A[i] ? (cols.A[i].chained ? '↓ ' : '') + cols.A[i].label : ''
    const b = cols.B[i] ? (cols.B[i].chained ? '↓ ' : '') + cols.B[i].label : ''
    const c = cols.C[i] ? (cols.C[i].chained ? '↓ ' : '') + cols.C[i].label : ''
    out.push(
      `  ${pad(i === 0 ? label : '', 5)}  ${pad(trunc(a, widths.A), widths.A)}  ${pad(trunc(b, widths.B), widths.B)}  ${pad(trunc(c, widths.C), widths.C)}`,
    )
  }
  return out
}

// biome-ignore lint/suspicious/noExplicitAny: raw GraphQL node
export function buildEpicData(data: any, richData: Map<number, any>): EpicData {
  const leaves: Leaf[] = []
  const subEpics: number[] = []

  for (const child of data.subIssues?.nodes ?? []) {
    const grandchildren = child.subIssues?.nodes ?? []
    const isSubEpic = grandchildren.length > 0

    if (isSubEpic) {
      subEpics.push(child.number)
      const richChild = richData.get(child.number)
      const gcNodes = richChild?.subIssues?.nodes ?? grandchildren
      for (const gc of gcNodes) {
        leaves.push({
          number: gc.number,
          title: gc.title,
          state: gc.state,
          blockedBy: parseBlockedBy(gc.body ?? null),
        })
      }
    } else {
      leaves.push({
        number: child.number,
        title: child.title,
        state: child.state,
        blockedBy: parseBlockedBy(child.body ?? null),
      })
    }
  }

  // biome-ignore lint/suspicious/noExplicitAny: raw GraphQL nodes
  const rawSubEpics: any[] = (data.subIssues?.nodes ?? []).filter(
    // biome-ignore lint/suspicious/noExplicitAny: raw GraphQL node
    (child: any) => (child.subIssues?.nodes ?? []).length > 0,
  )

  return {
    number: data.number,
    title: data.title,
    state: data.state,
    blockedBy: parseBlockedBy(data.body ?? null),
    leaves,
    subEpics,
    rawSubEpics,
  }
}
