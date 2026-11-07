import type { Diagnostic, Scope } from '../../engine/record-values.ts'
import type { Result } from '../../engine/result.ts'
import { githubScope } from '../github/transport.ts'
import type { GitHubOptions } from '../github/types.ts'
import { graphqlVariables } from './client.ts'

function actionFailure(code: string, message: string): Result<never> {
  return { ok: false, diagnostics: [{ code, message }] }
}

/**
 * One delivery observation. Cost, not a cache or a bulk comment reader:
 * one GraphQL page per 100 repository PRs, then the existing REST comment
 * reader (100 comments per page) for the UW, every candidate PR, and each
 * distinct mandate home needed to resolve a binding claim. GraphQL comment
 * identity is not proven equivalent to REST, so comments stay on that reader.
 * Absent and other-UW bindings are excluded before receipt or review expansion.
 * An unresolved claim or an unreadable required history refuses the read.
 */
const PULLS = `query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){pullRequests(first:100,after:$cursor,states:[OPEN,CLOSED,MERGED]){pageInfo{hasNextPage endCursor}nodes{number headRefName baseRefName repository{nameWithOwner}}}}}`

export type Candidate = { scope: Scope; branch: string; base: string }
type Page = { nodes: unknown[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }

function asPage(value: unknown): Page | null {
  if (value === null || typeof value !== 'object') return null
  const body = value as { nodes?: unknown; pageInfo?: { hasNextPage?: unknown; endCursor?: unknown } }
  const info = body.pageInfo
  if (!Array.isArray(body.nodes) || info === undefined || typeof info.hasNextPage !== 'boolean') return null
  if (typeof info.endCursor !== 'string' && info.endCursor !== null) return null
  return { nodes: body.nodes, pageInfo: { hasNextPage: info.hasNextPage, endCursor: info.endCursor } }
}

function asCandidate(value: unknown): Candidate | null {
  if (value === null || typeof value !== 'object') return null
  const node = value as {
    number?: unknown
    headRefName?: unknown
    baseRefName?: unknown
    repository?: { nameWithOwner?: unknown }
  }
  const repository = node.repository?.nameWithOwner
  if (typeof node.number !== 'number' || typeof node.headRefName !== 'string' || typeof node.baseRefName !== 'string')
    return null
  if (typeof repository !== 'string' || node.headRefName.length === 0 || node.baseRefName.length === 0) return null
  try {
    return { scope: githubScope(repository, node.number), branch: node.headRefName, base: node.baseRefName }
  } catch {
    return null
  }
}

async function readPullPage(
  owner: string,
  name: string,
  cursor: string | null,
  options: GitHubOptions,
): Promise<Result<Page>> {
  let data: unknown
  try {
    data = await graphqlVariables(options, PULLS, { owner, name, cursor })
  } catch (error) {
    return actionFailure(
      'record-unreadable',
      error instanceof Error ? error.message : 'Pull request enumeration is unreadable',
    )
  }
  const connection =
    data !== null && typeof data === 'object'
      ? (data as { repository?: { pullRequests?: unknown } }).repository?.pullRequests
      : undefined
  const page = asPage(connection)
  if (page === null) return actionFailure('incomplete', 'Pull request enumeration is incomplete')
  return { ok: true, value: page }
}

export type Enumeration = Result<Candidate[]> | { ok: false; diagnostics: Diagnostic[]; partial: Candidate[] }

export async function enumeratePullRequests(repository: string, options: GitHubOptions): Promise<Enumeration> {
  const found: Candidate[] = []
  const incomplete = (code: string, message: string): Enumeration => ({
    ok: false,
    diagnostics: [{ code, message }],
    partial: found,
  })
  const [owner, name] = repository.split('/')
  if (!owner || !name) return incomplete('record-unreadable', 'UW repository is not owner/name')
  const identities = new Map<string, Candidate>()
  const seen = new Set<string>()
  let cursor: string | null = null
  const collectPage = (nodes: unknown[]): Enumeration | null => {
    for (const node of nodes) {
      const candidate = asCandidate(node)
      if (candidate === null) return incomplete('incomplete', 'Pull request identity is incomplete')
      const key = `${candidate.scope.repository.toLowerCase()}\0${candidate.scope.target.toLowerCase()}`
      const previous = identities.get(key)
      if (previous !== undefined) {
        if (
          previous.scope.repository !== candidate.scope.repository ||
          previous.scope.target !== candidate.scope.target ||
          previous.branch !== candidate.branch ||
          previous.base !== candidate.base
        )
          return incomplete(
            'conflicting-duplicate',
            `Conflicting pull request observations for ${candidate.scope.target}`,
          )
        continue
      }
      identities.set(key, candidate)
      found.push(candidate)
    }
    return null
  }
  for (;;) {
    const page = await readPullPage(owner, name, cursor, options)
    if (!page.ok) return { ...page, partial: found }
    const invalid = collectPage(page.value.nodes)
    if (invalid !== null) return invalid
    if (!page.value.pageInfo.hasNextPage) return { ok: true, value: found }
    const next = page.value.pageInfo.endCursor
    if (next === null || next === '' || seen.has(next))
      return incomplete('incomplete', 'Pull request enumeration cursor did not advance')
    seen.add(next)
    cursor = next
  }
}
