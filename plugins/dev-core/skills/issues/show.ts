#!/usr/bin/env bun
/**
 * Fetch full details for a single GitHub issue and print formatted markdown.
 *
 * Usage: bun show.ts <issue-number>
 */

import { detectGitHubRepo } from '../shared/adapters/config-helpers'
import { parseBlockedBy, progressBar } from './lib/digest-helpers'
import { ghGraphQLExec } from './lib/gh-exec'

const issueNum = parseInt(process.argv[2] ?? '', 10)
if (!issueNum) {
  console.error('Usage: bun show.ts <issue-number>')
  process.exit(1)
}

function stripBlockedBySection(body: string): string {
  const lines = body.split('\n')
  const out: string[] = []
  let skip = false
  for (const line of lines) {
    if (/^##\s+blocked by/i.test(line)) {
      skip = true
      continue
    }
    if (skip && /^##/.test(line)) skip = false
    if (!skip) out.push(line)
  }
  return out.join('\n').trim()
}

function fmtDate(iso: string): string {
  return iso ? new Date(iso).toISOString().slice(0, 10) : ''
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

const ghProc = Bun.spawnSync(
  [
    'gh',
    'issue',
    'view',
    String(issueNum),
    '--json',
    'number,title,body,state,labels,assignees,milestone,createdAt,updatedAt,closedAt,comments',
  ],
  { stdout: 'pipe', stderr: 'pipe' },
)
if (ghProc.exitCode !== 0) {
  throw new Error(`gh issue view failed: ${new TextDecoder().decode(ghProc.stderr).trim()}`)
}
const raw = new TextDecoder().decode(ghProc.stdout).trim()
const issue: GhIssue = JSON.parse(raw)

// ── 2. Sub-issues via GraphQL ────────────────────────────────────────────────
interface SubIssue {
  number: number
  title: string
  state: 'OPEN' | 'CLOSED'
}

const [owner, repo] = detectGitHubRepo().split('/')

// ── 3. Sub-issues + blocked-by in a single GraphQL request ──────────────────
interface BlockerNode {
  number: number
  title: string
  state: 'OPEN' | 'CLOSED'
}

const gqlRaw = ghGraphQLExec(
  `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      subIssues(first: 50) {
        nodes { number title state }
      }
      trackedInIssues(first: 20) {
        nodes { number title state }
      }
    }
  }
}`,
  { owner, repo, number: issueNum },
) as {
  data: {
    repository: {
      issue: {
        subIssues: { nodes: SubIssue[] }
        trackedInIssues: { nodes: BlockerNode[] }
      }
    }
  }
}

const subIssues: SubIssue[] = gqlRaw.data.repository.issue?.subIssues?.nodes ?? []

// Fall back to body-parsed blockers if GraphQL returns nothing
const graphqlBlockers: BlockerNode[] = gqlRaw.data.repository.issue?.trackedInIssues?.nodes ?? []
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
if (issue.assignees.length) meta.push(`Assignees: ${issue.assignees.map((a) => `@${a.login}`).join(', ')}`)
if (issue.milestone) meta.push(`Milestone: ${issue.milestone.title}`)
lines.push(meta.join(' | '))

lines.push(
  `Created: ${fmtDate(issue.createdAt)} | Updated: ${fmtDate(issue.updatedAt)}${issue.closedAt ? ` | Closed: ${fmtDate(issue.closedAt)}` : ''}`,
)
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
  const progress = progressBar(subIssues.length - open, subIssues.length, { suffix: true, emptyBar: false })
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
