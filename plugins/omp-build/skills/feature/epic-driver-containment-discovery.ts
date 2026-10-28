import { graphql, Refused } from './epic-driver-runtime'

const PR_FIELDS = `number state baseRefName headRefName headRefOid mergedAt isCrossRepository
  mergeCommit { oid parents(first: 1) { nodes { oid } } }
  autoMergeRequest { enabledAt } labels(first: 30) { nodes { name } } repository { nameWithOwner }`

// Issue links and mandate branches discover candidates; neither grants authority.
const QUERY = `query EpicContainmentIssue($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      number repository { nameWithOwner }
      closedByPullRequestsReferences(first: 100, includeClosedPrs: true) {
        pageInfo { hasNextPage } nodes { ${PR_FIELDS} }
      }
      timelineItems(itemTypes: [CROSS_REFERENCED_EVENT], last: 100) {
        pageInfo { hasPreviousPage } nodes { ... on CrossReferencedEvent {
          source { __typename ... on PullRequest { ${PR_FIELDS} } }
        } }
      }
    }
  }
}`

const BRANCH_QUERY = `query EpicContainmentBranch($owner: String!, $name: String!, $head: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 100, headRefName: $head, states: OPEN) {
      pageInfo { hasNextPage }
      nodes { ${PR_FIELDS} }
    }
  }
}`

const PR_QUERY = `query EpicContainmentPullRequest($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${PR_FIELDS} } }
}`

export type Candidate = {
  number: number
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  baseRefName: string
  headRefName: string
  isCrossRepository: boolean
  repository: { nameWithOwner: string }
}
type IssueResponse = {
  repository: {
    issue: {
      number: number
      repository: { nameWithOwner: string }
      closedByPullRequestsReferences: { pageInfo: { hasNextPage: boolean }; nodes: Candidate[] }
      timelineItems: {
        pageInfo: { hasPreviousPage: boolean }
        nodes: { source: (Candidate & { __typename: string }) | { __typename: string } | null }[]
      }
    } | null
  }
}
type Locator = { repo: string; full: string; number: number }

function repository(full: string): { owner: string; name: string } {
  const [owner, name] = full.split('/')
  if (!owner || !name) throw new Refused(`containment repository ${full} is invalid`)
  return { owner, name }
}

export function readCandidate(context: Locator, number: number): unknown {
  return graphql<{ repository: { pullRequest: unknown } | null }>(context.repo, PR_QUERY, {
    ...repository(context.full),
    number,
  }).repository?.pullRequest
}

export function candidate(value: unknown): value is Candidate {
  if (value === null || typeof value !== 'object') return false
  const pr = value as Partial<Candidate>
  return (
    Number.isSafeInteger(pr.number) &&
    (pr.number ?? 0) > 0 &&
    (pr.state === 'OPEN' || pr.state === 'CLOSED' || pr.state === 'MERGED') &&
    typeof pr.baseRefName === 'string' &&
    pr.baseRefName.length > 0 &&
    typeof pr.headRefName === 'string' &&
    pr.headRefName.length > 0 &&
    typeof pr.isCrossRepository === 'boolean' &&
    typeof pr.repository?.nameWithOwner === 'string'
  )
}

function timelineCandidates(
  timeline: NonNullable<IssueResponse['repository']['issue']>['timelineItems'],
  target: string,
): unknown[] {
  const found: unknown[] = []
  for (const entry of timeline.nodes) {
    if (!entry || !('source' in entry)) throw new Refused(`containment timeline for ${target} is unreadable`)
    if (entry.source === null) continue
    if (entry.source.__typename === 'PullRequest') found.push(entry.source)
    else if (typeof entry.source.__typename !== 'string')
      throw new Refused(`containment timeline for ${target} is unreadable`)
  }
  return found
}

export function uniqueCandidates(values: readonly unknown[], full: string, target: string): Candidate[] {
  const found = new Map<number, Candidate>()
  for (const value of values) {
    if (!candidate(value)) throw new Refused(`containment PR discovery for ${target} is unreadable`)
    if (value.isCrossRepository || value.repository.nameWithOwner !== full || value.state !== 'OPEN') continue
    const previous = found.get(value.number)
    if (previous && (previous.headRefName !== value.headRefName || previous.baseRefName !== value.baseRefName))
      throw new Refused(`containment PR #${value.number} has conflicting observations`)
    found.set(value.number, value)
  }
  return [...found.values()]
}

export function exactIssueCandidates(context: Locator): Candidate[] {
  const { repo, full, number } = context
  const issue = graphql<IssueResponse>(repo, QUERY, { ...repository(full), number }).repository?.issue
  if (!issue || issue.number !== number || issue.repository?.nameWithOwner !== full)
    throw new Refused(`containment issue ${full}#${number} is inaccessible or mismatched`)
  const closed = issue.closedByPullRequestsReferences
  const timeline = issue.timelineItems
  if (
    !closed ||
    !timeline ||
    closed.pageInfo?.hasNextPage !== false ||
    timeline.pageInfo?.hasPreviousPage !== false ||
    !Array.isArray(closed.nodes) ||
    !Array.isArray(timeline.nodes)
  )
    throw new Refused(`containment PR discovery for ${full}#${number} is incomplete`)
  const target = `${full}#${number}`
  return uniqueCandidates([...closed.nodes, ...timelineCandidates(timeline, target)], full, target)
}

export function branchCandidates(context: Locator, head: string): Candidate[] {
  const data = graphql<{ repository: { pullRequests: { pageInfo: { hasNextPage: boolean }; nodes: unknown[] } } }>(
    context.repo,
    BRANCH_QUERY,
    { ...repository(context.full), head },
  )
  const connection = data.repository?.pullRequests
  if (connection?.pageInfo?.hasNextPage !== false || !Array.isArray(connection.nodes))
    throw new Refused(`containment PR discovery for branch ${head} is incomplete`)
  const found = uniqueCandidates(connection.nodes, context.full, `branch ${head}`)
  if (found.some((pr) => pr.headRefName !== head))
    throw new Refused(`containment PR discovery for branch ${head} is unreadable`)
  return found
}
