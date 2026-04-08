#!/usr/bin/env bun
/**
 * Fetches open epics + sub-issue trees, renders the status table as markdown,
 * and appends a minimal JSON block for parallel-lanes generation.
 *
 * Usage: bun digest.ts
 */

import { execSync } from 'node:child_process'
import { unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
      for (const m of line.matchAll(/#(\d+)/g)) nums.push(parseInt(m[1]))
    }
  }
  return nums
}

interface GCI {
  n: number
  t: string
  s: 'O' | 'C'
}
interface CI {
  n: number
  t: string
  s: 'O' | 'C'
  bl: number[]
  ch: GCI[]
}
interface ER {
  n: number
  t: string
  pr: { d: number; tot: number }
  bl: number[]
  ch: CI[]
}

function countAll(items: any[]): number {
  return items.reduce((acc, i) => acc + 1 + (i.subIssues?.nodes?.length ?? 0), 0)
}
function countClosed(items: any[]): number {
  return items.reduce((acc, i) => {
    const self = i.state === 'CLOSED' ? 1 : 0
    const subs = (i.subIssues?.nodes ?? []).filter((c: any) => c.state === 'CLOSED').length
    return acc + self + subs
  }, 0)
}

// ── 1. Fetch open epics ──────────────────────────────────────────────────────
const { owner, repo } = detectRepo()

const epicsRaw = execSync(
  `gh issue list --repo ${owner}/${repo} --label epic --state open --json number,title --limit 50`,
  { encoding: 'utf-8' },
)
const epics: Array<{ number: number; title: string }> = JSON.parse(epicsRaw)

if (epics.length === 0) {
  console.log('## Current Status\n\n*(no open epics)*')
  process.exit(0)
}

// ── 2. Batch GraphQL ─────────────────────────────────────────────────────────
const issueFields = `
  number title state body
  subIssues(first: 50) {
    nodes {
      number title state body
      subIssues(first: 30) {
        nodes { number title state }
      }
    }
  }
`
const aliases = epics.map((e, i) => `e${i}: issue(number: ${e.number}) { ${issueFields} }`).join('\n')
const query = `{ repository(owner: "${owner}", name: "${repo}") { ${aliases} } }`
const raw = ghGraphQL(query) as { data: { repository: Record<string, any> } }
const repoData = raw.data.repository

// ── 3. Build structured data ─────────────────────────────────────────────────
const result: ER[] = epics.flatMap((epic, i) => {
  const data = repoData[`e${i}`]
  if (!data) return []

  const rawCh: any[] = data.subIssues?.nodes ?? []
  const pr = { d: countClosed(rawCh), tot: countAll(rawCh) }

  const ch: CI[] = rawCh.map((c: any) => ({
    n: c.number,
    t: c.title,
    s: c.state === 'OPEN' ? 'O' : ('C' as 'O' | 'C'),
    bl: parseBlockedBy(c.body),
    ch: (c.subIssues?.nodes ?? []).map((gc: any) => ({
      n: gc.number,
      t: gc.title,
      s: gc.state === 'OPEN' ? 'O' : ('C' as 'O' | 'C'),
    })),
  }))

  return [{ n: data.number, t: data.title, pr, bl: parseBlockedBy(data.body), ch }]
})

// ── 4. Render status table ───────────────────────────────────────────────────
const epicNums = new Set(result.map((e) => e.n))
const epicMap = new Map(result.map((e) => [e.n, e]))

function bar(d: number, tot: number): string {
  if (tot === 0) return '░░░░░ 0/0'
  const f = Math.round((d / tot) * 5)
  return '█'.repeat(f) + '░'.repeat(5 - f) + ` ${d}/${tot}`
}

function nextCell(ch: CI[]): string {
  const open = ch.filter((c) => c.s === 'O')
  if (open.length === 0) return '—'
  const cand = open.find((c) => c.bl.length === 0) ?? open[0]
  if (epicNums.has(cand.n)) {
    const sub = epicMap.get(cand.n)
    if (sub) {
      const subOpen = sub.ch.filter((c) => c.s === 'O')
      if (subOpen.length > 0) {
        const nc = subOpen.find((c) => c.bl.length === 0) ?? subOpen[0]
        return `#${nc.n} (via #${cand.n})`
      }
    }
    return `#${cand.n}`
  }
  return `#${cand.n} ${cand.t}`
}

const rows = ['| # | Epic | Progress | Open | Next |', '|---|------|----------|------|------|']

const seenChild = new Set<number>()

for (const epic of result) {
  const open = epic.pr.tot - epic.pr.d
  rows.push(`| #${epic.n} | ${epic.t} | ${bar(epic.pr.d, epic.pr.tot)} | ${open} | ${nextCell(epic.ch)} |`)

  for (const child of epic.ch) {
    if (child.s !== 'O' || !epicNums.has(child.n)) continue
    const sub = epicMap.get(child.n)!
    const seen = seenChild.has(child.n)
    seenChild.add(child.n)
    const title = seen ? '*(see above)*' : sub.t
    const subOpen = sub.pr.tot - sub.pr.d
    rows.push(`|  ↳ #${sub.n} | ${title} | ${bar(sub.pr.d, sub.pr.tot)} | ${subOpen} | ${nextCell(sub.ch)} |`)
  }
}

// ── 5. Build minimal lanes JSON (structure only, no titles) ──────────────────
// Claude uses this to generate the parallel-lanes section; titles are in the table above.
const lanesData = result.map((e) => ({
  n: e.n,
  bl: e.bl,
  sub: e.ch.filter((c) => epicNums.has(c.n)).map((c) => c.n),
}))

// ── 6. Output ────────────────────────────────────────────────────────────────
console.log('## Current Status')
console.log('')
console.log(rows.join('\n'))
console.log('')
console.log(`<!-- lanes:${JSON.stringify(lanesData)} -->`)
