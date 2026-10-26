export type NativeEpicPullRequest = {
  number: number
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  baseRefName: string
  headRefName: string
  headRefOid: string
  mergedAt: string | null
  mergeCommit: { oid: string; parents: { nodes: { oid: string }[] } } | null
  autoMergeRequest: { enabledAt: string } | null
  labels: { nodes: { name: string }[] }
  repository: { nameWithOwner: string }
  isCrossRepository: boolean
}

type RawChild = {
  number: number
  title: string
  state: 'OPEN' | 'CLOSED'
  body: string | null
  repository: { nameWithOwner: string }
  labels: { nodes: { name: string }[] }
  blockedBy: { nodes: { number: number; state: 'OPEN' | 'CLOSED'; repository: { nameWithOwner: string } }[] }
  closedByPullRequestsReferences: { nodes: NativeEpicPullRequest[] }
  timelineItems: { nodes: ({ source?: Partial<NativeEpicPullRequest> | null } | null)[] }
}

export type NativeEpicChild = {
  number: number
  title: string
  state: 'OPEN' | 'CLOSED'
  body: string | null
  repository: string
  labels: string[]
  blockedBy: { number: number; state: 'OPEN' | 'CLOSED'; repository: string }[]
  closedByPullRequests: NativeEpicPullRequest[]
  timelinePullRequestSources: ({ source?: Partial<NativeEpicPullRequest> | null } | null)[]
}

type EpicData = {
  repository: {
    issue: {
      subIssues: { pageInfo: { hasNextPage: boolean }; nodes: RawChild[] }
    } | null
  }
}

export type NativeGraphql = <T>(query: string, variables: Record<string, string | number>) => T

const PR_FIELDS = `number state baseRefName headRefName headRefOid mergedAt isCrossRepository
  mergeCommit { oid parents(first: 1) { nodes { oid } } }
  autoMergeRequest { enabledAt } labels(first: 30) { nodes { name } } repository { nameWithOwner }`

const EPIC_QUERY = `query($owner: String!, $name: String!, $epic: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $epic) {
      subIssues(first: 100) {
        pageInfo { hasNextPage }
        nodes {
          number title state body repository { nameWithOwner }
          labels(first: 50) { nodes { name } }
          blockedBy(first: 50) { nodes { number state repository { nameWithOwner } } }
          closedByPullRequestsReferences(first: 20, includeClosedPrs: true) { nodes { ${PR_FIELDS} } }
          timelineItems(itemTypes: [CROSS_REFERENCED_EVENT], last: 50) {
            nodes { ... on CrossReferencedEvent { source { ... on PullRequest { ${PR_FIELDS} } } } }
          }
        }
      }
    }
  }
}`

export function readNativeEpicChildren(
  owner: string,
  name: string,
  epic: number,
  full: string,
  graphql: NativeGraphql,
  refuse: (message: string) => never,
): NativeEpicChild[] {
  const issue = graphql<EpicData>(EPIC_QUERY, { owner, name, epic }).repository.issue
  if (!issue) return refuse(`#${epic} does not exist in ${full}`)
  if (issue.subIssues.pageInfo.hasNextPage) return refuse(`#${epic} has more than 100 sub-issues`)
  return issue.subIssues.nodes.map((child) => ({
    number: child.number,
    title: child.title,
    state: child.state,
    body: child.body,
    repository: child.repository.nameWithOwner,
    labels: child.labels.nodes.map((label) => label.name),
    blockedBy: child.blockedBy.nodes.map((blocker) => ({
      number: blocker.number,
      state: blocker.state,
      repository: blocker.repository.nameWithOwner,
    })),
    closedByPullRequests: child.closedByPullRequestsReferences.nodes,
    timelinePullRequestSources: child.timelineItems.nodes,
  }))
}
