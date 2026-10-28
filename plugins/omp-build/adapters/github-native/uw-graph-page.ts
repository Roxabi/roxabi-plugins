import type { Scope } from '../../engine/record-values.ts'
import { type GitHubOptions, RECORD_REPOSITORY } from '../github/types.ts'
import { graphqlVariables, splitRepository } from '../github-workflow/client.ts'
import { UW_GRAPH_QUERY } from './uw-graph-query.ts'
import type { Connection, GraphqlIssue } from './uw-graph-shape.ts'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
function asRepository(value: unknown): string | null {
  const record = asRecord(value)
  return typeof record?.nameWithOwner === 'string' ? record.nameWithOwner : null
}
function isPageInfo(value: unknown): value is { hasNextPage: boolean; endCursor: string | null } {
  const record = asRecord(value)
  return typeof record?.hasNextPage === 'boolean' && (typeof record.endCursor === 'string' || record.endCursor === null)
}
function isConnection(value: unknown): value is Connection<unknown> {
  const record = asRecord(value)
  return Array.isArray(record?.nodes) && isPageInfo(record.pageInfo)
}
function validRef(value: unknown): boolean {
  const reference = asRecord(value)
  const repository = reference === null ? null : asRepository(reference.repository)
  return (
    reference !== null &&
    typeof reference.number === 'number' &&
    Number.isSafeInteger(reference.number) &&
    reference.number > 0 &&
    repository !== null &&
    RECORD_REPOSITORY.test(repository)
  )
}
function validLabels(value: unknown): boolean {
  return isConnection(value) && value.nodes.every((entry) => typeof asRecord(entry)?.name === 'string')
}
function validReferences(value: unknown): boolean {
  return isConnection(value) && value.nodes.every(validRef)
}
function parseIssue(value: unknown): GraphqlIssue | null {
  const issue = asRecord(value)
  const required =
    issue !== null &&
    typeof issue.number === 'number' &&
    Number.isSafeInteger(issue.number) &&
    issue.number > 0 &&
    typeof issue.title === 'string' &&
    typeof issue.body === 'string' &&
    typeof issue.updatedAt === 'string' &&
    (issue.state === 'OPEN' || issue.state === 'CLOSED') &&
    (typeof issue.stateReason === 'string' || issue.stateReason === null) &&
    asRepository(issue.repository) !== null &&
    (issue.parent === null || validRef(issue.parent)) &&
    validLabels(issue.labels) &&
    validReferences(issue.subIssues) &&
    validReferences(issue.blockedBy)
  return required ? (issue as unknown as GraphqlIssue) : null
}

export async function page(
  scope: Scope,
  options: GitHubOptions,
  cursors: Record<'labelsCursor' | 'childrenCursor' | 'blockersCursor', string | undefined>,
): Promise<GraphqlIssue> {
  const { owner, name } = splitRepository(scope.repository)
  const number = Number(scope.target.slice(scope.target.lastIndexOf('#') + 1))
  const data = await graphqlVariables(options, UW_GRAPH_QUERY, {
    owner,
    name,
    number,
    ...cursors,
  })
  const repository = asRecord(data)?.repository
  const issue = parseIssue(asRecord(repository)?.issue)
  if (issue === null || issue.repository.nameWithOwner !== scope.repository || issue.number !== number)
    throw new Error(`Native graph payload for ${scope.target} is incomplete`)
  return issue
}
