#!/usr/bin/env bun
/**
 * Fetch full details for a single GitHub issue and print formatted markdown.
 *
 * Usage: bun show.ts <issue-number>
 */

import { execSync } from 'node:child_process'
import { unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const issueNum = parseInt(process.argv[2] ?? '')
if (!issueNum) {
  console.error('Usage: bun show.ts <issue-number>')
  process.exit(1)
}

function detectRepo(): { owner: string; repo: string } {
  const nwo = execSync('gh repo view --json nameWithOwner --jq .nameWithOwner', {
    encoding: 'utf-8',
  }).trim()
  const [owner, repo] = nwo.split('/')
  return { owner, repo }
}

function ghGraphQL(query: string): unknown {
  const tmpFile = join(tmpdir(), `show-${Date.now()}.json`)
  writeFileSync(tmpFile, JSON.stringify({ query }))
  try {
    const out = execSync(`gh api graphql --input ${tmpFile}`, { encoding: 'utf-8' })
    return JSON.parse(out)
  } finally {
    unlinkSync(tmpFile)
  }
}

function parseBlockedBy(body: string | null): number[] {
  if (!body) return []
  const nums: number[] = []
  let inSection = false
  for (const line of body.split('\n')) {
    if (/^##\s+blocked by/i.test(line)) { inSection = true; continue }
    if (inSection && /^##/.test(line)) break
    if (inSection) {
      for (const m of line.matchAll(/#(\d+)/g)) nums.push(parseInt(m[1]))
    }
  }
  return nums
}

function stripBlockedBySection(body: string): string {
  const lines = body.split('\n')
  const out: string[] = []
  let skip = false
  for (const line of lines) {
    if (/^##\s+blocked by/i.test(line)) { skip = true; continue }
    if (skip && /^##/.test(line)) skip = false
    if (!skip) out.push(line)
  }
  return out.join('\n').trim()
}

function fmtDate(iso: string): string {
  return iso ? new Date(iso).toISOString().slice(0, 10) : ''
}

function bar(closed: number, total: number): string {
  if (total === 0) return ''
  const filled = Math.round((closed / total) * 5)
  return `${'█'.repeat(filled)}${'░'.repeat(5 - filled)} ${closed}/${total}`
}

// ── 1. Core fields via gh CLI ────────────────────────────────────────────────
interface GhComment {
  author: { login: string }
  body: string
  createdAt: string
}

interface GhIssue {
  number: number
  title: string
  body: string
  state: 'OPEN' | 'CLOSED'
  labels: { name: string }[]
  assignees: { login: string }[]
  milestone: { title: string } | null
  createdAt: string
  updatedAt: string
  closedAt: string | null
  comments: GhComment[]
}

const raw = execSync(
  `gh issue view ${issueNum} --json number,title,body,state,labels,assignees,milestone,createdAt,updatedAt,closedAt,comments`,
  { encoding: 'utf-8' },
)
const issue: GhIssue = JSON.parse(raw)

// ── 2. Sub-issues via GraphQL ────────────────────────────────────────────────
interface SubIssue { number: number; title: string; state: 'OPEN' | 'CLOSED' }

const { owner, repo } = detectRepo()
const gqlRaw = ghGraphQL(`{
  repository(owner: "${owner}", name: "${repo}") {
    issue(number: ${issueNum}) {
      subIssues(first: 50) {
        nodes { number title state }
      }
    }
  }
}`) as { data: { repository: { issue: { subIssues: { nodes: SubIssue[] } } } } }

const subIssues: SubIssue[] = gqlRaw.data.repository.issue?.subIssues?.nodes ?? []

// ── 3. Blocked-by state via GraphQL (actual GitHub blockers, not just body) ──
interface BlockerNode { number: number; title: string; state: 'OPEN' | 'CLOSED' }

const blockersRaw = ghGraphQL(`{
  repository(owner: "${owner}", name: "${repo}") {
    issue(number: ${issueNum}) {
      trackedInIssues(first: 20) {
        nodes { number title state }
      }
    }
  }
}`) as { data: { repository: { issue: { trackedInIssues: { nodes: BlockerNode[] } } } } }

// Fall back to body-parsed blockers if GraphQL returns nothing
const graphqlBlockers: BlockerNode[] = blockersRaw.data.repository.issue?.trackedInIssues?.nodes ?? []
const bodyBlockerNums = parseBlockedBy(issue.body)
const blockers: BlockerNode[] =
  graphqlBlockers.length > 0
    ? graphqlBlockers
    : bodyBlockerNums.map((n) => ({ number: n, title: `#${n}`, state: 'OPEN' }))

// ── 4. Extract label categories ───────────────────────────────────────────────
const labelNames = issue.labels.map((l) => l.name)
const size = labelNames.find((l) => l.startsWith('size:'))?.replace('size:', '') ?? '-'
const priority = labelNames.find((l) => l.startsWith('priority:'))?.replace('priority:', '') ?? '-'
const otherLabels = labelNames.filter((l) => !l.startsWith('size:') && !l.startsWith('priority:'))

// ── 5. Format output ──────────────────────────────────────────────────────────
const lines: string[] = []
const state = issue.state === 'OPEN' ? 'OPEN' : 'CLOSED'

lines.push(`## #${issue.number} — ${issue.title}  [${state}]`)
lines.push('')

// Metadata row
const meta: string[] = []
if (otherLabels.length) meta.push(`Labels: ${otherLabels.join(', ')}`)
meta.push(`Size: ${size}`)
meta.push(`Priority: ${priority}`)
if (issue.assignees.length) meta.push(`Assignees: ${issue.assignees.map((a) => '@' + a.login).join(', ')}`)
if (issue.milestone) meta.push(`Milestone: ${issue.milestone.title}`)
lines.push(meta.join(' | '))

lines.push(`Created: ${fmtDate(issue.createdAt)} | Updated: ${fmtDate(issue.updatedAt)}${issue.closedAt ? ` | Closed: ${fmtDate(issue.closedAt)}` : ''}`)
lines.push('')

// Description (body minus Blocked by section)
const description = stripBlockedBySection(issue.body ?? '')
if (description) {
  lines.push('### Description')
  lines.push('')
  lines.push(description)
  lines.push('')
}

// Sub-issues
if (subIssues.length > 0) {
  const open = subIssues.filter((s) => s.state === 'OPEN').length
  const progress = bar(subIssues.length - open, subIssues.length)
  lines.push(`### Sub-issues  ${progress}`)
  lines.push('')
  for (const s of subIssues) {
    const check = s.state === 'OPEN' ? '[ ]' : '[x]'
    lines.push(`- ${check} #${s.number} ${s.title}`)
  }
  lines.push('')
}

// Blockers
if (blockers.length > 0) {
  lines.push('### Blocked by')
  lines.push('')
  for (const b of blockers) {
    const icon = b.state === 'OPEN' ? '⛔' : '✅'
    lines.push(`- ${icon} #${b.number} ${b.title}  [${b.state}]`)
  }
  lines.push('')
}

// Comments
if (issue.comments.length > 0) {
  lines.push(`### Comments (${issue.comments.length})`)
  lines.push('')
  for (const c of issue.comments) {
    lines.push(`**@${c.author.login}** · ${fmtDate(c.createdAt)}`)
    lines.push('')
    lines.push(c.body.trim())
    lines.push('')
  }
}

console.log(lines.join('\n'))
