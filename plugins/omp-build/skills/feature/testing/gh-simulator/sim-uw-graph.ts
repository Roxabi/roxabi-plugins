import { fullName, type State } from './sim-types.ts'

function paged<T>(
  values: readonly T[],
  after: string | undefined,
): { nodes: readonly T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } {
  const offset = after === undefined ? 0 : Number(after)
  const start = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0
  const nodes = values.slice(start, start + 100)
  const next = start + nodes.length
  return {
    nodes,
    pageInfo: { hasNextPage: next < values.length, endCursor: next < values.length ? String(next) : null },
  }
}

export function graphIssueResponse(state: State, number: string | undefined, vars: Record<string, string>): unknown {
  const issue = state.issues[String(number)]
  if (!issue) return { data: { repository: { issue: null } } }
  const parent = Object.values(state.issues).find((candidate) => candidate.subIssues.includes(issue.number))
  const repository = { nameWithOwner: fullName(state) }
  return {
    data: {
      repository: {
        issue: {
          number: issue.number,
          title: issue.title,
          body: issue.body,
          updatedAt: issue.updatedAt ?? null,
          state: issue.state,
          stateReason: issue.stateReason ?? null,
          repository,
          parent: parent ? { number: parent.number, repository } : null,
          labels: paged(
            issue.labels.map((name) => ({ name })),
            vars.labelsCursor,
          ),
          subIssues: paged(
            issue.subIssues.map((child) => ({ number: child, repository })),
            vars.childrenCursor,
          ),
          blockedBy: paged(
            issue.blockedBy.map((blocker) => ({ number: blocker, repository })),
            vars.blockersCursor,
          ),
        },
      },
    },
  }
}
