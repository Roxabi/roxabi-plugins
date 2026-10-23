import type { GitHubOptions } from '../dist/contracts.js'

export const ROXABI_STOP_AUTHOR = 'github-actions[bot]'

/**
 * Roxabi's product adapter recognizes the trusted CI stop writer in addition to
 * the normal configured native identity. Callers cannot opt out of that reader
 * policy by supplying partial GitHub options.
 */
export function withRoxabiGitHubPolicy(options: GitHubOptions): GitHubOptions {
  return { ...options, stopAuthor: ROXABI_STOP_AUTHOR }
}
