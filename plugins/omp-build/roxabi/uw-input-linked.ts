import type { GitHubOptions } from '../adapters/github/types.ts'
import {
  decodeHistory,
  equalScope,
  githubScope,
  graphqlVariables,
  readGitHubHistory,
  selectWorkflowBinding,
} from '../dist/contracts.js'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import type { Result } from '../engine/result.ts'
import { actionFailure } from './uw-action-result.ts'

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

type Candidate = { scope: Scope; branch: string; base: string }
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

async function enumeratePullRequests(repository: string, options: GitHubOptions): Promise<Result<Candidate[]>> {
  const [owner, name] = repository.split('/')
  if (!owner || !name) return actionFailure('record-unreadable', 'UW repository is not owner/name')
  const found: Candidate[] = []
  const seen = new Set<string>()
  let cursor: string | null = null
  for (;;) {
    const page = await readPullPage(owner, name, cursor, options)
    if (!page.ok) return page
    for (const node of page.value.nodes) {
      const candidate = asCandidate(node)
      if (candidate === null) return actionFailure('incomplete', 'Pull request identity is incomplete')
      found.push(candidate)
    }
    if (!page.value.pageInfo.hasNextPage) return { ok: true, value: found }
    const next = page.value.pageInfo.endCursor
    if (next === null || next === '' || seen.has(next))
      return actionFailure('incomplete', 'Pull request enumeration cursor did not advance')
    seen.add(next)
    cursor = next
  }
}

async function decodeScope(scope: Scope, options: GitHubOptions): Promise<Result<DecodedHistory>> {
  try {
    return { ok: true, value: decodeHistory(await readGitHubHistory(scope, options)) }
  } catch (error) {
    return actionFailure(
      'record-unreadable',
      `${scope.repository} ${scope.target} history is unreadable: ${error instanceof Error ? error.message : 'GitHub read failed'}`,
    )
  }
}

function mandateHomes(history: DecodedHistory, loaded: ReadonlyMap<string, DecodedHistory>): Scope[] {
  const scopes: Scope[] = []
  for (const operation of history.operations) {
    const record = operation.record
    if (record?.kind !== 'workflow-binding') continue
    const scope = record.payload.mandate.scope
    const key = `${scope.repository}\0${scope.target}`
    if (loaded.has(key) || scopes.some((item) => item.repository === scope.repository && item.target === scope.target))
      continue
    scopes.push(scope)
  }
  return scopes
}

async function resolveCandidateBinding(
  candidate: Candidate,
  pr: DecodedHistory,
  options: GitHubOptions,
  loaded: Map<string, DecodedHistory>,
): Promise<Result<ReturnType<typeof selectWorkflowBinding>>> {
  const native = { branch: candidate.branch, base: candidate.base }
  let selected = selectWorkflowBinding({ pullRequest: candidate.scope, histories: [...loaded.values()], native })
  if (selected.status === 'incomplete') {
    for (const scope of mandateHomes(pr, loaded)) {
      const read = await decodeScope(scope, options)
      if (!read.ok) return read
      loaded.set(`${scope.repository}\0${scope.target}`, read.value)
    }
    selected = selectWorkflowBinding({ pullRequest: candidate.scope, histories: [...loaded.values()], native })
  }
  return { ok: true, value: selected }
}

async function collectCandidate(
  candidate: Candidate,
  uw: Scope,
  options: GitHubOptions,
  loaded: Map<string, DecodedHistory>,
  kept: DecodedHistory[],
): Promise<Result<true>> {
  const key = `${candidate.scope.repository}\0${candidate.scope.target}`
  let pr = loaded.get(key)
  if (pr === undefined) {
    const read = await decodeScope(candidate.scope, options)
    if (!read.ok) return read
    pr = read.value
    loaded.set(key, pr)
  }
  const binding = await resolveCandidateBinding(candidate, pr, options, loaded)
  if (!binding.ok) return binding
  const selected = binding.value
  if (selected.status === 'absent') return { ok: true, value: true }
  if (selected.status !== 'bound') {
    return actionFailure(
      selected.diagnostics[0]?.code ?? 'incomplete',
      selected.diagnostics[0]?.message ?? 'Pull request binding is unresolved',
    )
  }
  if (!equalScope(selected.mandateRecord.payload.ownSpec.uw, uw)) return { ok: true, value: true }
  if (!kept.includes(pr)) kept.push(pr)
  const home = loaded.get(`${selected.mandate.scope.repository}\0${selected.mandate.scope.target}`)
  if (home !== undefined && !kept.includes(home)) kept.push(home)
  return { ok: true, value: true }
}

export async function readDeliveryHistories(uw: Scope, options: GitHubOptions): Promise<Result<DecodedHistory[]>> {
  const candidates = await enumeratePullRequests(uw.repository, options)
  if (!candidates.ok) return candidates
  const issue = await decodeScope(uw, options)
  if (!issue.ok) return issue
  const loaded = new Map<string, DecodedHistory>([[`${uw.repository}\0${uw.target}`, issue.value]])
  const kept: DecodedHistory[] = [issue.value]
  for (const candidate of candidates.value) {
    const collected = await collectCandidate(candidate, uw, options, loaded, kept)
    if (!collected.ok) return collected
  }
  return { ok: true, value: kept }
}
