import type { ReviewTier } from './roster-contract'

/** Trim, then map legacy sizes. Anything else is F-lite — the CLI says so on stderr. */
export function normalizeTier(raw: string): ReviewTier {
  const value = raw
    .trim()
    .replace(/^size:\s*/i, '')
    .trim()
  const key = value.toLowerCase()
  if (key === 's' || key === 'xs') return 'S'
  if (key === 'm' || key === 'f-lite') return 'F-lite'
  if (key === 'l' || key === 'xl' || key === 'f-full') return 'F-full'
  return 'F-lite'
}
