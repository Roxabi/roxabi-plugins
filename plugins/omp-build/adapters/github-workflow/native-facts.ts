import type { Scope } from '../../engine/record-values.ts'
import { githubScope } from '../github/transport.ts'
import { diagnostic, GitHubHistoryReadError, type GitHubOptions, gh } from '../github/types.ts'
import { readNativeIssueFacts, scopeNumber } from '../github-native/issue-facts.ts'
import { parseJson, resolveRepository } from './client.ts'
import { type NativePullRequestFacts, type NativeTargetResolution, object, POSITIVE_INT, SHA } from './types.ts'

function referenceNumber(reference: string | number): number | null {
  if (typeof reference === 'number') return Number.isSafeInteger(reference) && reference >= 1 ? reference : null
  const match = /^(?:#|pr\/|issue\/)?([1-9][0-9]*)$/i.exec(reference.trim())
  if (match === null) return null
  const number = Number(match[1])
  return Number.isSafeInteger(number) ? number : null
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
