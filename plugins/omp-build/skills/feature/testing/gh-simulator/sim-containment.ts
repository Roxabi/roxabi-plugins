import { fullName, type Pull, type State } from './sim-types.ts'

type PullNode = (state: State, pr: Pull) => Record<string, unknown>

export function containmentResponse(
  state: State,
  query: string,
  vars: Record<string, string>,
  prNode: PullNode,
): unknown | undefined {
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
    const pulls = Object.values(state.prs).filter((pr) => pr.state === 'OPEN' && pr.headRefName === vars.head)
    return {
      data: {
        repository: { pullRequests: { pageInfo: { hasNextPage: false }, nodes: pulls.map((pr) => prNode(state, pr)) } },
      },
    }
  }
  return undefined
}
