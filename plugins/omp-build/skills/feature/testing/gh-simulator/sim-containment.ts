import { fullName, type Pull, type State } from './sim-types.ts'

type PullNode = (state: State, pr: Pull) => Record<string, unknown>

function linkedPullsResponse(state: State, number: string | undefined): unknown {
  const nodes = Object.values(state.prs)
    .filter((pr) => pr.closes.includes(Number(number)))
    .map((pr) => ({ number: pr.number, state: pr.state, repository: { nameWithOwner: fullName(state) } }))
  return {
    data: { repository: { issue: { closedByPullRequestsReferences: { pageInfo: { hasNextPage: false }, nodes } } } },
  }
}

export function containmentResponse(
  state: State,
  query: string,
  vars: Record<string, string>,
  prNode: PullNode,
): unknown | undefined {
  if (query.includes('query LinkedPullRequests(')) return linkedPullsResponse(state, vars.number)
  if (query.includes('EpicContainmentIssue')) {
    const issue = state.issues[String(vars.number)]
    const linked = Object.values(state.prs).filter((pr) => pr.closes.includes(Number(vars.number)))
    return {
      data: {
        repository: {
          issue: issue
            ? {
                number: issue.number,
                repository: { nameWithOwner: fullName(state) },
                closedByPullRequestsReferences: {
                  pageInfo: { hasNextPage: false },
                  nodes: linked.filter((pr) => pr.state !== 'OPEN').map((pr) => prNode(state, pr)),
                },
                timelineItems: {
                  pageInfo: { hasPreviousPage: false },
                  nodes: linked
                    .filter((pr) => pr.state === 'OPEN')
                    .map((pr) => ({ source: { __typename: 'PullRequest', ...prNode(state, pr) } })),
                },
              }
            : null,
        },
      },
    }
  }
  if (query.includes('EpicContainmentBranch')) {
    const pulls = Object.values(state.prs).filter((pr) => pr.headRefName === vars.head)
    return {
      data: {
        repository: { pullRequests: { pageInfo: { hasNextPage: false }, nodes: pulls.map((pr) => prNode(state, pr)) } },
      },
    }
  }
  return undefined
}
