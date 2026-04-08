#!/usr/bin/env bun
/**
 * Fetches open epics + sub-issue trees for the digest view.
 * Output: JSON consumed by the --digest / -D skill section.
 *
 * Usage: bun digest.ts
 */

import { execSync } from 'node:child_process'
import { writeFileSync, unlinkSync } from 'node:fs'
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

/** Parse issue numbers from the "## Blocked by" section of a body. */
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

interface ChildIssue {
  number: number
  title: string
  state: 'OPEN' | 'CLOSED'
  blockedBy: number[]
  children: GrandchildIssue[]
}

interface GrandchildIssue {
  number: number
  title: string
  state: 'OPEN' | 'CLOSED'
}

interface EpicResult {
  number: number
  title: string
  state: 'OPEN' | 'CLOSED'
  progress: { closed: number; total: number }
  blockedBy: number[]
  children: ChildIssue[]
}

function countAll(items: ChildIssue[]): number {
  return items.reduce((acc, i) => acc + 1 + (i.children?.length ?? 0), 0)
}

function countClosed(items: ChildIssue[]): number {
  return items.reduce((acc, i) => {
    const self = i.state === 'CLOSED' ? 1 : 0
    const subs = (i.children ?? []).filter(c => c.state === 'CLOSED').length
    return acc + self + subs
  }, 0)
}

// 1. Find all open epics
const { owner, repo } = detectRepo()

const epicsRaw = execSync(
  `gh issue list --repo ${owner}/${repo} --label epic --state open --json number,title --limit 50`,
  { encoding: 'utf-8' },
)
const epics: Array<{ number: number; title: string }> = JSON.parse(epicsRaw)

if (epics.length === 0) {
  console.log(JSON.stringify({ epics: [] }, null, 2))
  process.exit(0)
}

// 2. Batch GraphQL — fetch sub-issue trees (depth 2) + body for blocker parsing
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

// 3. Build output
const result: EpicResult[] = epics.flatMap((epic, i) => {
  const data = repoData[`e${i}`]
  if (!data) return []

  const children: ChildIssue[] = (data.subIssues?.nodes ?? []).map((child: any) => ({
    number: child.number,
    title: child.title,
    state: child.state,
    blockedBy: parseBlockedBy(child.body),
    children: (child.subIssues?.nodes ?? []).map((gc: any) => ({
      number: gc.number,
      title: gc.title,
      state: gc.state,
    })),
  }))

  return [{
    number: data.number,
    title: data.title,
    state: data.state,
    progress: { closed: countClosed(children), total: countAll(children) },
    blockedBy: parseBlockedBy(data.body),
    children,
  }]
})

console.log(JSON.stringify({ owner, repo, epics: result }, null, 2))
