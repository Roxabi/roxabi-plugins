#!/usr/bin/env bun
/**
 * Compact digest view — epic progress table + parallel execution lanes.
 * Output: formatted ASCII table, consumed verbatim by the --digest / -D skill.
 *
 * Usage: bun digest.ts
 */

import { execSync } from 'node:child_process'
import { unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ─── Fetch helpers ────────────────────────────────────────────────────────────

function ghGraphQL(query: string): unknown {
  const tmpFile = join(tmpdir(), `digest-${Date.now()}.json`)
  writeFileSync(tmpFile, JSON.stringify({ query }))
  try {
    const out = execSync(`gh api graphql --input ${tmpFile}`, { encoding: 'utf-8' })
    return JSON.parse(out)
  } finally {
    unlinkSync(tmpFile)
  }
}

function detectRepo(): { owner: string; repo: string } {
  const nwo = execSync('gh repo view --json nameWithOwner --jq .nameWithOwner', {
    encoding: 'utf-8',
  }).trim()
  const [owner, repo] = nwo.split('/')
  return { owner, repo }
}

function parseBlockedBy(body: string | null): number[] {
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

// ─── Types ────────────────────────────────────────────────────────────────────

interface Leaf {
  number: number
  title: string
  state: 'OPEN' | 'CLOSED'
  blockedBy: number[]
}

interface EpicData {
  number: number
  title: string
  state: 'OPEN' | 'CLOSED'
  blockedBy: number[]
  leaves: Leaf[] // all leaf issues (depth 1 or 2)
  subEpics: number[] // child issue numbers that are also epics
  rawSubEpics: unknown[]
}

// ─── Fetch ────────────────────────────────────────────────────────────────────

const { owner, repo } = detectRepo()

const epicsRaw = execSync(
  `gh issue list --repo ${owner}/${repo} --label epic --state open --json number,title --limit 50`,
  { encoding: 'utf-8' },
)
const topEpics: Array<{ number: number; title: string }> = JSON.parse(epicsRaw)

if (topEpics.length === 0) {
  console.log('● 0 epics')
  process.exit(0)
}

const issueFields = `
  number title state body
  subIssues(first: 50) {
    nodes {
      number title state body
      subIssues(first: 30) {
        nodes { number title state body }
      }
    }
  }
`

const aliases = topEpics.map((e, i) => `e${i}: issue(number: ${e.number}) { ${issueFields} }`).join('\n')
const query = `{ repository(owner: "${owner}", name: "${repo}") { ${aliases} } }`
// biome-ignore lint/suspicious/noExplicitAny: raw GraphQL response
const raw = ghGraphQL(query) as { data: { repository: Record<string, any> } }
const repoData = raw.data.repository

// biome-ignore lint/suspicious/noExplicitAny: raw GraphQL nodes
const richData = new Map<number, any>()
for (let i = 0; i < topEpics.length; i++) {
  const data = repoData[`e${i}`]
  if (data) richData.set(data.number, data)
}

// Build EpicData from raw node, using richData for grandchildren if available
// biome-ignore lint/suspicious/noExplicitAny: raw GraphQL node
function buildEpicData(data: any): EpicData {
  const leaves: Leaf[] = []
  const subEpics: number[] = []

  for (const child of data.subIssues?.nodes ?? []) {
    const grandchildren = child.subIssues?.nodes ?? []
    const isSubEpic = grandchildren.length > 0

    if (isSubEpic) {
      subEpics.push(child.number)
      // Use richData for this child if available (has full body+blockedBy for each grandchild)
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

  // Collect raw sub-epic nodes (for those not in richData)
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

// ─── Build rows ───────────────────────────────────────────────────────────────

// Which epic numbers appear as children of other epics
const childEpicNums = new Set<number>()
for (const [, data] of richData) {
  for (const child of data?.subIssues?.nodes ?? []) {
    if ((child.subIssues?.nodes ?? []).length > 0) {
      childEpicNums.add(child.number)
    }
  }
}

interface EpicRow {
  number: number
  title: string
  state: 'OPEN' | 'CLOSED'
  progress: { closed: number; total: number }
  depth: number
  data: EpicData
}

const rows: EpicRow[] = []
const shownNums = new Set<number>()

function addRow(data: EpicData, depth: number) {
  if (data.state === 'CLOSED') return
  if (shownNums.has(data.number)) return
  shownNums.add(data.number)

  const total = data.leaves.length
  const closed = data.leaves.filter((l) => l.state === 'CLOSED').length

  rows.push({
    number: data.number,
    title: data.title,
    state: data.state,
    progress: { closed, total },
    depth,
    data,
  })

  // Inline sub-epics as depth+1 rows (use richData if available, else raw child data)
  for (const _rawChild of data.rawSubEpics) {
    // biome-ignore lint/suspicious/noExplicitAny: raw GraphQL node
    const rawChild = _rawChild as any
    if (rawChild.state === 'CLOSED') continue
    const subRaw = richData.get(rawChild.number) ?? rawChild
    addRow(buildEpicData(subRaw), depth + 1)
  }
}

for (let i = 0; i < topEpics.length; i++) {
  const data = repoData[`e${i}`]
  if (!data || data.state === 'CLOSED') continue
  // Skip if already shown as a ↳ child
  if (childEpicNums.has(data.number)) continue
  addRow(buildEpicData(data), 0)
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

function progressBar(closed: number, total: number): string {
  if (total === 0) return '░░░░░'
  const filled = Math.round((closed / total) * 5)
  return '█'.repeat(filled) + '░'.repeat(5 - filled)
}

function pad(s: string, n: number, align: 'l' | 'r' | 'c' = 'l'): string {
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

function trunc(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`
}

function stripType(title: string): string {
  return title
    .replace(/^(feat|fix|chore|refactor|docs|test|ops|style)\([^)]+\):\s*/i, '')
    .replace(/^(feat|fix|chore|refactor|docs|test|ops|style):\s*/i, '')
}

function nextIssue(row: EpicRow): string {
  const open = row.data.leaves.filter((l) => l.state === 'OPEN')
  if (open.length === 0) return '✓ done'
  const unblocked = open.filter((l) => l.blockedBy.length === 0)
  const pick = unblocked[0] ?? open[0]
  return `#${pick.number} ${trunc(stripType(pick.title), 24)}`
}

function openCount(row: EpicRow): number {
  return row.data.leaves.filter((l) => l.state === 'OPEN').length
}

// ─── Table ────────────────────────────────────────────────────────────────────

const COL = { num: 8, epic: 52, prog: 11, open: 4, next: 26 }
const SEP = ' │ '

function trow(num: string, epic: string, prog: string, open: string, next: string): string {
  return `${pad(num, COL.num)}${SEP}${pad(epic, COL.epic)}${SEP}${pad(prog, COL.prog)}${SEP}${pad(open, COL.open, 'r')}${SEP}${pad(next, COL.next)}`
}

const totalWidth = COL.num + COL.epic + COL.prog + COL.open + COL.next + SEP.length * 4

const lines: string[] = []
lines.push('● Current state')
lines.push(trow('  #', 'Epic', 'Progress', 'Open', 'Next'))
lines.push('─'.repeat(totalWidth))

for (const r of rows) {
  const prefix = r.depth > 0 ? '↳ ' : ''
  const numStr = `${prefix}#${r.number}`
  const epicTitle = r.title.replace(/^epic\([^)]+\):\s*/i, '').replace(/^epic:\s+/i, '')
  const { closed, total } = r.progress
  const progStr = `${progressBar(closed, total)} ${closed}/${total}`
  lines.push(trow(numStr, trunc(epicTitle, COL.epic), progStr, String(openCount(r)), nextIssue(r)))
}
console.log(lines.join('\n'))

// ─── Execution lanes ──────────────────────────────────────────────────────────

function lane(title: string): 'A' | 'B' | 'C' {
  const t = title.toLowerCase()
  if (/brand|lora|v23|v24|avatar|pulid/.test(t)) return 'C'
  if (/infra|nats|security|ops\(infra|ops\(sec|quadlet|podman|docker|supervisor|\bci\b|provision/.test(t)) return 'A'
  return 'B'
}

// Active = has its own progress
function isActive(r: EpicRow): boolean {
  return r.progress.closed > 0
}

// Collect all open leaves from active epics only, with their open-issue context
const activeOpenNums = new Set<number>()
const leafMap = new Map<number, { title: string; blockedBy: number[]; active: boolean }>()

for (const r of rows) {
  if (!isActive(r)) continue
  for (const l of r.data.leaves) {
    if (l.state === 'OPEN') activeOpenNums.add(l.number)
  }
}

// Also need all open nums (to resolve blockers correctly)
const allOpenNums = new Set<number>()
for (const r of rows) {
  for (const l of r.data.leaves) {
    if (l.state === 'OPEN') allOpenNums.add(l.number)
  }
}

// Process depth-0 first, then depth-1+ overrides (more specific wins)
for (const r of [...rows].sort((a, b) => a.depth - b.depth)) {
  const active = isActive(r)
  for (const l of r.data.leaves) {
    if (l.state === 'CLOSED') continue
    // Always overwrite — depth-1 rows set more specific active flag for their own leaves
    leafMap.set(l.number, { title: l.title, blockedBy: l.blockedBy, active })
  }
}

type LTask = { num: number; title: string; blockedBy: number[] }

const phase1: LTask[] = []
const _phase2: LTask[] = []
const _phase3: LTask[] = []

for (const [num, v] of leafMap) {
  if (!v.active) continue
  const openBlockers = v.blockedBy.filter((b) => allOpenNums.has(b))
  phase1.push({ num, title: v.title, blockedBy: openBlockers })
}
// Sort into phases
const p1nums = new Set<number>()
const p2nums = new Set<number>()
const p3nums = new Set<number>()
const _deferred: LTask[] = []

for (const t of phase1) {
  const openB = t.blockedBy.filter((b) => allOpenNums.has(b))
  if (openB.length === 0) p1nums.add(t.num)
}
for (const t of phase1) {
  if (p1nums.has(t.num)) continue
  const openB = t.blockedBy.filter((b) => allOpenNums.has(b) && !p1nums.has(b))
  if (openB.length === 0) p2nums.add(t.num)
}
for (const t of phase1) {
  if (p1nums.has(t.num) || p2nums.has(t.num)) continue
  const openB = t.blockedBy.filter((b) => allOpenNums.has(b) && !p1nums.has(b) && !p2nums.has(b))
  if (openB.length === 0) p3nums.add(t.num)
}

function buildCols(
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

const WA = 38,
  WB = 38,
  WC = 34
const hdr = `  ${'Phase'.padEnd(5)}  ${'Lane A (Infra/NATS)'.padEnd(WA)}  ${'Lane B (Features/Core)'.padEnd(WB)}  ${'Lane C (Brand ops)'.padEnd(WC)}`
const sep = `  ${'─'.repeat(5)}  ${'─'.repeat(WA)}  ${'─'.repeat(WB)}  ${'─'.repeat(WC)}`

function renderCols(
  label: string,
  cols: Record<'A' | 'B' | 'C', Array<{ label: string; chained: boolean }>>,
): string[] {
  const max = Math.max(cols.A.length, cols.B.length, cols.C.length)
  if (max === 0) return []
  const out: string[] = []
  for (let i = 0; i < max; i++) {
    const a = cols.A[i] ? (cols.A[i].chained ? '↓ ' : '') + cols.A[i].label : ''
    const b = cols.B[i] ? (cols.B[i].chained ? '↓ ' : '') + cols.B[i].label : ''
    const c = cols.C[i] ? (cols.C[i].chained ? '↓ ' : '') + cols.C[i].label : ''
    out.push(
      `  ${pad(i === 0 ? label : '', 5)}  ${pad(trunc(a, WA), WA)}  ${pad(trunc(b, WB), WB)}  ${pad(trunc(c, WC), WC)}`,
    )
  }
  return out
}

const laneOut: string[] = ['', 'Execution order — 3 parallel lanes', hdr, sep]

if (p1nums.size > 0) laneOut.push(...renderCols('1', buildCols(p1nums)))
if (p2nums.size > 0) {
  laneOut.push(sep)
  laneOut.push(...renderCols('2', buildCols(p2nums, p1nums)))
}
if (p3nums.size > 0) {
  laneOut.push(sep)
  laneOut.push(...renderCols('3', buildCols(p3nums, p2nums)))
}

// Deferred: inactive epics (top-level or sub-epics with no progress)
const deferredRows = rows.filter((r) => !isActive(r))
if (deferredRows.length > 0) {
  laneOut.push(sep)
  const dCols: Record<'A' | 'B' | 'C', Array<{ label: string; chained: boolean }>> = { A: [], B: [], C: [] }
  for (const r of deferredRows) {
    const l = lane(r.title)
    dCols[l].push({ label: `⏸ #${r.number} ${trunc(stripType(r.title), 30)}`, chained: false })
  }
  laneOut.push(...renderCols('—', dCols))
}

console.log(laneOut.join('\n'))
