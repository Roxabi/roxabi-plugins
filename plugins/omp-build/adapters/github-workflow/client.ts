import type { Json } from '../../engine/record-values.ts'
import { diagnostic, GitHubHistoryReadError, type GitHubOptions, gh, RECORD_REPOSITORY } from '../github/types.ts'
import { object } from './types.ts'

export function splitRepository(repository: string): { owner: string; name: string } {
  if (!RECORD_REPOSITORY.test(repository)) {
    throw new GitHubHistoryReadError('GitHub repository is invalid', [
      diagnostic('invalid-scope', `Repository ${repository} is not owner/name`),
    ])
  }
  const [owner, name] = repository.split('/')
  if (!owner || !name) {
    throw new GitHubHistoryReadError('GitHub repository is invalid', [
      diagnostic('invalid-scope', `Repository ${repository} is not owner/name`),
    ])
  }
  return { owner, name }
}

export function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    throw new GitHubHistoryReadError(`${label} is not JSON`, [
      diagnostic('invalid-github-response', `${label} is not valid JSON`),
    ])
  }
}

export async function graphql(
  options: GitHubOptions,
  query: string,
  variables: { owner: string; name: string; number: number },
): Promise<unknown> {
  const raw = await gh(options)(options.cwd, [
    'api',
    'graphql',
    '-f',
    `query=${query}`,
    '-f',
    `owner=${variables.owner}`,
    '-f',
    `name=${variables.name}`,
    '-F',
    `number=${variables.number}`,
  ])
  const parsed = object(parseJson(raw, 'GitHub GraphQL response'))
  if (parsed === null) {
    throw new GitHubHistoryReadError('GitHub GraphQL response is invalid', [
      diagnostic('invalid-github-response', 'GraphQL response is not an object'),
    ])
  }
  if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
    throw new GitHubHistoryReadError('GitHub GraphQL returned errors', [
      diagnostic('github-read-failed', 'GraphQL errors prevent a complete native read', parsed.errors as Json),
    ])
  }
  if (!('data' in parsed) || parsed.data === null || parsed.data === undefined) {
    throw new GitHubHistoryReadError('GitHub GraphQL data is absent', [
      diagnostic('incomplete', 'GraphQL data is absent'),
    ])
  }
  return parsed.data
}

export async function resolveRepository(options: GitHubOptions, repository?: string): Promise<string> {
  if (repository !== undefined) {
    if (!RECORD_REPOSITORY.test(repository)) {
      throw new GitHubHistoryReadError('GitHub repository is invalid', [
        diagnostic('invalid-scope', `Repository ${repository} is not owner/name`),
      ])
    }
    return repository
  }
  const raw = await gh(options)(options.cwd, ['repo', 'view', '--json', 'nameWithOwner'])
  const parsed = object(parseJson(raw, 'gh repo view'))
  const nameWithOwner = parsed?.nameWithOwner
  if (typeof nameWithOwner !== 'string' || !RECORD_REPOSITORY.test(nameWithOwner)) {
    throw new GitHubHistoryReadError('GitHub repository identity is unreadable', [
      diagnostic('unreadable', 'gh repo view did not return nameWithOwner'),
    ])
  }
  return nameWithOwner
}
