import type { Scope } from '../../engine/record-values.ts'
import { githubScope } from '../github/transport.ts'
import { GitHubHistoryReadError, type GitHubOptions } from '../github/types.ts'
import { gh, parseJson, resolveRepository } from './client.ts'
import {
  diagnostic,
  type NativeIssueFacts,
  type NativePullRequestFacts,
  type NativeTargetResolution,
  object,
  POSITIVE_INT,
  RECORD_REPOSITORY,
  SHA,
} from './types.ts'

export function scopeNumber(scope: Scope): number {
  const separator = scope.target.lastIndexOf('#')
  const repository = separator > 0 ? scope.target.slice(0, separator) : ''
  const number = separator > 0 ? Number(scope.target.slice(separator + 1)) : Number.NaN
  if (
    !RECORD_REPOSITORY.test(scope.repository) ||
    repository !== scope.repository ||
    !Number.isSafeInteger(number) ||
    number < 1
  ) {
    throw new GitHubHistoryReadError('GitHub scope is invalid', [
      diagnostic('invalid-scope', `Scope ${scope.target} is not a GitHub repository issue target`),
    ])
  }
  return number
}

function referenceNumber(reference: string | number): number | null {
  if (typeof reference === 'number') return Number.isSafeInteger(reference) && reference >= 1 ? reference : null
  const match = /^(?:#|pr\/|issue\/)?([1-9][0-9]*)$/i.exec(reference.trim())
  if (match === null) return null
  const number = Number(match[1])
  return Number.isSafeInteger(number) ? number : null
}

/** Read native issue metadata. A pull request issue payload is reported, not rewritten. */
export async function readNativeIssueFacts(
  repository: string,
  number: number,
  options: GitHubOptions,
): Promise<NativeIssueFacts> {
  if (!POSITIVE_INT.test(String(number))) {
    throw new GitHubHistoryReadError('GitHub issue number is invalid', [
      diagnostic('invalid-scope', `Issue number ${number} is invalid`),
    ])
  }
  const raw = await gh(options)(options.cwd, ['api', `repos/${repository}/issues/${number}`])
  const parsed = object(parseJson(raw, `issue #${number}`))
  const user = object(parsed?.user)
  const author = typeof user?.login === 'string' ? user.login : null
  const state = parsed?.state
  const returnedNumber = parsed?.number
  const body = parsed?.body
  if (
    parsed === null ||
    returnedNumber !== number ||
    (state !== 'open' && state !== 'closed') ||
    typeof state !== 'string' ||
    typeof body !== 'string'
  ) {
    throw new GitHubHistoryReadError(`Issue #${number} is unreadable`, [
      diagnostic('unreadable', `Issue #${number} native payload is incomplete`),
    ])
  }
  return {
    repository,
    number,
    state: state.toUpperCase(),
    author,
    body,
    isPullRequest: object(parsed.pull_request) !== null,
  }
}

/** Fail-closed exact issue body reader for an opaque Scope. Missing body refuses. */
export async function readScopeIssueBody(scope: Scope, options: GitHubOptions): Promise<string> {
  const facts = await readNativeIssueFacts(scope.repository, scopeNumber(scope), options)
  return facts.body
}

/** Read native pull-request head/base/branch facts. Missing fields refuse. */
export async function readNativePullRequestFacts(
  repository: string,
  pr: number,
  options: GitHubOptions,
): Promise<NativePullRequestFacts> {
  if (!POSITIVE_INT.test(String(pr))) {
    throw new GitHubHistoryReadError('GitHub pull request number is invalid', [
      diagnostic('invalid-scope', `Pull request number ${pr} is invalid`),
    ])
  }
  const raw = await gh(options)(options.cwd, [
    'pr',
    'view',
    String(pr),
    '--repo',
    repository,
    '--json',
    'number,state,headRefOid,headRefName,baseRefName,baseRefOid,author',
  ])
  const parsed = object(parseJson(raw, `pull request #${pr}`))
  const authorObject = object(parsed?.author)
  const author = typeof authorObject?.login === 'string' ? authorObject.login : null
  const number = parsed?.number
  const state = parsed?.state
  const head = parsed?.headRefOid
  const branch = parsed?.headRefName
  const base = parsed?.baseRefName
  const baseTip = parsed?.baseRefOid
  if (
    number !== pr ||
    typeof state !== 'string' ||
    typeof head !== 'string' ||
    !SHA.test(head) ||
    typeof branch !== 'string' ||
    branch.length === 0 ||
    typeof base !== 'string' ||
    base.length === 0 ||
    typeof baseTip !== 'string' ||
    !SHA.test(baseTip)
  ) {
    throw new GitHubHistoryReadError(`Pull request #${pr} is unreadable`, [
      diagnostic('unreadable', `Pull request #${pr} native head/base facts are incomplete`),
    ])
  }
  return { repository, pr, head, base, baseTip, branch, state, author }
}

/**
 * Resolve an explicit operator reference to an existing issue or PR.
 * Fix-only may target either; this never creates a ticket.
 */
export async function resolveNativeTarget(
  reference: string | number,
  options: GitHubOptions,
  repository?: string,
): Promise<NativeTargetResolution> {
  try {
    const number = referenceNumber(reference)
    if (number === null)
      return {
        status: 'refused',
        diagnostics: [diagnostic('invalid-reference', `Reference ${JSON.stringify(reference)} is not an issue or PR`)],
      }
    const resolvedRepository = await resolveRepository(options, repository)
    const issue = await readNativeIssueFacts(resolvedRepository, number, options)
    if (!issue.isPullRequest) return { status: 'issue', scope: githubScope(resolvedRepository, number), issue }
    const pullRequest = await readNativePullRequestFacts(resolvedRepository, number, options)
    return { status: 'pull-request', scope: githubScope(resolvedRepository, number), pullRequest }
  } catch (error) {
    if (error instanceof GitHubHistoryReadError) {
      const codes = new Set(error.diagnostics.map((entry) => entry.code))
      return {
        status: codes.has('incomplete') ? 'incomplete' : codes.has('ambiguous') ? 'ambiguous' : 'unreadable',
        diagnostics: error.diagnostics,
      }
    }
    return {
      status: 'unreadable',
      diagnostics: [diagnostic('github-read-failed', error instanceof Error ? error.message : String(error))],
    }
  }
}

/**
 * Resolve a previously recorded GitHub scope without interpreting it as an
 * operator reference. Its repository and target must agree exactly; resolution
 * never falls back to the repository inferred from the current working tree.
 */
export async function resolveNativeScope(scope: Scope, options: GitHubOptions): Promise<NativeTargetResolution> {
  try {
    return await resolveNativeTarget(scopeNumber(scope), options, scope.repository)
  } catch (error) {
    if (error instanceof GitHubHistoryReadError) return { status: 'refused', diagnostics: error.diagnostics }
    return {
      status: 'unreadable',
      diagnostics: [diagnostic('github-read-failed', error instanceof Error ? error.message : String(error))],
    }
  }
}
