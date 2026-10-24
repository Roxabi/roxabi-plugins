import type { History } from '../../engine/history-schema.ts'
import type { Scope } from '../../engine/record-values.ts'
import type { ObservedComment } from '../../engine/review-schema.ts'
import {
  diagnostic,
  expectedReadAuthor,
  GitHubHistoryReadError,
  type GitHubOptions,
  gh,
  parseComment,
  RECORD_REPOSITORY,
  targetNumber,
} from './types.ts'

/** Construct the opaque core scope used for either an issue or a pull request. */
export function githubScope(repository: string, number: number): Scope {
  if (!RECORD_REPOSITORY.test(repository) || !Number.isSafeInteger(number) || number < 1) {
    throw new RangeError('GitHub scope requires owner/repository and a positive issue number')
  }
  return { repository, target: `${repository}#${number}` }
}

function validateAuthors(expectedAuthor: string, stopAuthor: string | null): void {
  if (!expectedAuthor || /\s/.test(expectedAuthor)) {
    throw new GitHubHistoryReadError('GitHub expected author is invalid', [
      diagnostic('missing-native-author', 'Expected GitHub author is absent or invalid'),
    ])
  }
  if (stopAuthor !== null && (!stopAuthor || /\s/.test(stopAuthor))) {
    throw new GitHubHistoryReadError('GitHub stop author is invalid', [
      diagnostic('missing-native-author', 'Stop GitHub author is absent or invalid'),
    ])
  }
}

async function readCommentPage(scope: Scope, number: number, page: number, options: GitHubOptions): Promise<unknown[]> {
  const output = await gh(options)(options.cwd, [
    'api',
    `repos/${scope.repository}/issues/${number}/comments?per_page=100&page=${page}`,
  ])
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    throw new GitHubHistoryReadError('GitHub comment page is not JSON', [
      diagnostic('invalid-github-response', `Comment page ${page} is not valid JSON`),
    ])
  }
  if (!Array.isArray(parsed)) {
    throw new GitHubHistoryReadError('GitHub comment page is not an array', [
      diagnostic('invalid-github-response', `Comment page ${page} is not an array`),
    ])
  }
  return parsed
}

export async function readWithAuthor(
  scope: Scope,
  options: GitHubOptions,
  expectedAuthor: string,
  stopAuthor: string | null,
): Promise<History> {
  const number = targetNumber(scope)
  validateAuthors(expectedAuthor, stopAuthor)
  const comments: ObservedComment[] = []
  try {
    for (let page = 1; ; page += 1) {
      const parsed = await readCommentPage(scope, number, page, options)
      comments.push(...parsed.map((entry, index) => parseComment(entry, scope, page, index)))
      if (parsed.length < 100) break
    }
  } catch (error) {
    if (error instanceof GitHubHistoryReadError) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new GitHubHistoryReadError('GitHub comments could not be read', [diagnostic('github-read-failed', message)])
  }
  return { scope, expectedAuthor, stopAuthor, complete: true, comments, diagnostics: [] }
}

/** Read every issue/PR comment and retain native identity and revision metadata. */
export async function readGitHubHistory(scope: Scope, options: GitHubOptions): Promise<History> {
  return readWithAuthor(scope, options, await expectedReadAuthor(options), options.stopAuthor ?? null)
}
