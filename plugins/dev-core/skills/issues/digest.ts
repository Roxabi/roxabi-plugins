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
import {
  buildCols,
  buildEpicData,
  COL,
  type EpicData,
  type EpicRow,
  isActive,
  lane,
  nextIssue,
  openCount,
  progressBar,
  renderCols,
  SEP,
  stripType,
  trow,
  trunc,
} from './lib/digest-helpers'

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

// buildEpicData imported from digest-helpers — pass richData as parameter
const _buildEpicData = (data: unknown) => buildEpicData(data, richData)

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
    addRow(_buildEpicData(subRaw), depth + 1)
  }
}

for (let i = 0; i < topEpics.length; i++) {
  const data = repoData[`e${i}`]
  if (!data || data.state === 'CLOSED') continue
  // Skip if already shown as a ↳ child
  if (childEpicNums.has(data.number)) continue
  addRow(_buildEpicData(data), 0)
}

// ─── Table ────────────────────────────────────────────────────────────────────

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

const phase1: { num: number; title: string; blockedBy: number[] }[] = []

for (const [num, v] of leafMap) {
  if (!v.active) continue
  const openBlockers = v.blockedBy.filter((b) => allOpenNums.has(b))
  phase1.push({ num, title: v.title, blockedBy: openBlockers })
}
// Sort into phases
const p1nums = new Set<number>()
const p2nums = new Set<number>()
const p3nums = new Set<number>()

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

const _buildCols = (nums: Set<number>, prevNums?: Set<number>) => buildCols(leafMap, nums, prevNums)

const WA = 38,
  WB = 38,
  WC = 34
const W = { A: WA, B: WB, C: WC }
const hdr = `  ${'Phase'.padEnd(5)}  ${'Lane A (Infra/NATS)'.padEnd(WA)}  ${'Lane B (Features/Core)'.padEnd(WB)}  ${'Lane C (Brand ops)'.padEnd(WC)}`
const sep = `  ${'─'.repeat(5)}  ${'─'.repeat(WA)}  ${'─'.repeat(WB)}  ${'─'.repeat(WC)}`

const laneOut: string[] = ['', 'Execution order — 3 parallel lanes', hdr, sep]

if (p1nums.size > 0) laneOut.push(...renderCols('1', _buildCols(p1nums), W))
if (p2nums.size > 0) {
  laneOut.push(sep)
  laneOut.push(...renderCols('2', _buildCols(p2nums, p1nums), W))
}
if (p3nums.size > 0) {
  laneOut.push(sep)
  laneOut.push(...renderCols('3', _buildCols(p3nums, p2nums), W))
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
  laneOut.push(...renderCols('—', dCols, W))
}

console.log(laneOut.join('\n'))
