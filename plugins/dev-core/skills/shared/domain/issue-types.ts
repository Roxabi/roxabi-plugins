/**
 * Issue type constants — single source of truth for issue classification strings.
 * Consumed by set.ts (validation) and migrate.ts (legacy map keys).
 */

export const ISSUE_TYPE_NAMES = ['feat', 'fix', 'docs', 'test', 'chore', 'ci', 'perf', 'refactor'] as const

export const EXTENDED_ISSUE_TYPES = ['epic', 'research'] as const
