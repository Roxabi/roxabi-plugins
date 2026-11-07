import type { State } from './sim-types.ts'

export function commentNodeResponse(state: State, query: string, vars: Record<string, string>): unknown | undefined {
  if (!query.includes('IssueComment') || !query.includes('lastEditedAt')) return undefined
  const id = vars.id ?? vars.nodeId ?? /node\(id:\s*"([^"]+)"\)/.exec(query)?.[1]
  for (const pr of Object.values(state.prs)) {
    const comment = pr.comments.find((entry) => (entry.nodeId ?? `IC_${entry.id}`) === id)
    if (!comment) continue
    const number = comment.associatedNumber ?? pr.number
    const repositoryId = comment.associatedRepositoryId ?? state.repositoryId ?? 1
    return {
      data: {
        node: {
          __typename: 'IssueComment',
          id: comment.nodeId ?? `IC_${comment.id}`,
          fullDatabaseId: String(comment.id),
          pullRequest: { number, fullDatabaseId: String(state.prs[String(number)]?.databaseId ?? 1000 + number) },
          lastEditedAt: comment.lastEditedAt ?? null,
          repository: { fullDatabaseId: String(repositoryId) },
        },
      },
    }
  }
  return { data: { node: null } }
}
