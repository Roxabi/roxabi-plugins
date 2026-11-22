import type { Gh } from '../adapters/github/types.ts'
import { isRecord } from './feature-engine.ts'

export type PullRequestList = { numbers: number[]; incomplete: boolean; evidence: unknown }

export function parsePullRequestList(source: 'linked' | 'branch', raw: string): PullRequestList {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return {
      numbers: [],
      incomplete: true,
      evidence: { source, status: 'invalid-json', error: error instanceof Error ? error.message : 'invalid-json' },
    }
  }
  if (!Array.isArray(parsed)) {
    return { numbers: [], incomplete: true, evidence: { source, status: 'non-array-response' } }
  }
  const numbers: number[] = []
  let invalid = parsed.length >= 1000
  for (const item of parsed) {
    if (
      item === null ||
      typeof item !== 'object' ||
      !('number' in item) ||
      typeof item.number !== 'number' ||
      !Number.isSafeInteger(item.number) ||
      item.number <= 0 ||
      !('state' in item) ||
      typeof item.state !== 'string' ||
      !['OPEN', 'CLOSED', 'MERGED'].includes(item.state)
    ) {
      invalid = true
      continue
    }
    if (item.state !== 'MERGED') numbers.push(item.number)
  }
  return {
    numbers,
    incomplete: invalid,
    evidence: { source, status: invalid ? 'invalid-entries' : 'complete', numbers },
  }
}

// GitHub search has no per-issue `linked:` filter: `linked:issue:N` means "linked to any issue".
const LINKED_PULL_REQUESTS = `query LinkedPullRequests($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      closedByPullRequestsReferences(first: 100, includeClosedPrs: true) {
        pageInfo { hasNextPage }
        nodes { number state repository { nameWithOwner } }
      }
    }
  }
}`

/** This repository's closing PRs on the first page; a PR closing it from another repository is not ours to disarm. */
function linkedPage(raw: string, repository: string): { nodes: unknown[]; more: boolean } {
  const response: unknown = JSON.parse(raw)
  const data = isRecord(response) && isRecord(response.data) ? response.data : null
  const home = data !== null && isRecord(data.repository) ? data.repository : null
  const issue = home !== null && isRecord(home.issue) ? home.issue : null
  const linked = issue?.closedByPullRequestsReferences
  if (!isRecord(linked) || !isRecord(linked.pageInfo) || !Array.isArray(linked.nodes))
    throw new Error('linked-pull-requests-unreadable')
  const nodes = linked.nodes.flatMap((node) => {
    const owner = isRecord(node) && isRecord(node.repository) ? node.repository.nameWithOwner : undefined
    if (typeof owner !== 'string') return [null]
    return owner === repository ? [node] : []
  })
  return { nodes, more: linked.pageInfo.hasNextPage !== false }
}

export async function linkedPullRequests(
  gh: Gh,
  cwd: string,
  repository: string,
  issue: number,
): Promise<PullRequestList> {
  const [owner = '', name = ''] = repository.split('/')
  try {
    const raw = await gh(cwd, [
      'api',
      'graphql',
      '-f',
      `query=${LINKED_PULL_REQUESTS}`,
      '-f',
      `owner=${owner}`,
      '-f',
      `name=${name}`,
      '-F',
      `number=${issue}`,
    ])
    const page = linkedPage(raw, repository)
    const list = parsePullRequestList('linked', JSON.stringify(page.nodes))
    if (!page.more) return list
    return { numbers: list.numbers, incomplete: true, evidence: { source: 'linked', status: 'truncated', list } }
  } catch (error) {
    return {
      numbers: [],
      incomplete: true,
      evidence: { source: 'linked', status: 'failed', error: error instanceof Error ? error.message : 'list-failed' },
    }
  }
}

function unmergedBranchPrNumber(pr: unknown): number | null | undefined {
  if (
    !isRecord(pr) ||
    !Number.isSafeInteger(pr.number) ||
    (pr.number as number) <= 0 ||
    (pr.state !== 'open' && pr.state !== 'closed') ||
    !('merged_at' in pr) ||
    (pr.merged_at !== null && typeof pr.merged_at !== 'string') ||
    (pr.state === 'open' && pr.merged_at !== null) ||
    (typeof pr.merged_at === 'string' && !pr.merged_at)
  )
    return undefined
  return pr.merged_at === null ? (pr.number as number) : null
}

export async function branchPrNumbers(gh: Gh, cwd: string, endpoint: string): Promise<Set<number> | null> {
  const numbers = new Set<number>()
  for (let page = 1; ; page++) {
    const results: unknown = JSON.parse(await gh(cwd, ['api', `${endpoint}&page=${page}`]))
    if (!Array.isArray(results) || results.length > 100) return null
    for (const pr of results) {
      const number = unmergedBranchPrNumber(pr)
      if (number === undefined) return null
      if (number !== null) numbers.add(number)
    }
    if (results.length < 100) return numbers
  }
}
