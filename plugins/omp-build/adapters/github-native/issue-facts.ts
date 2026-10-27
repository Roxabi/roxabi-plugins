import type { Scope } from '../../engine/record-values.ts'
import { diagnostic, GitHubHistoryReadError, type GitHubOptions, gh, RECORD_REPOSITORY } from '../github/types.ts'
import { parseJson } from '../github-workflow/client.ts'
import { type NativeIssueFacts, object, POSITIVE_INT } from '../github-workflow/types.ts'

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
