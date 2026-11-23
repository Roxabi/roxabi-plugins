import { object } from './types.ts'

export function pinnedReviewApp(rules: unknown): number | undefined {
  if (!Array.isArray(rules)) return undefined
  const ids = new Set<number>()
  for (const entry of rules) {
    const rule = object(entry)
    if (rule?.type !== 'required_status_checks') continue
    const checks = object(rule.parameters)?.required_status_checks
    if (!Array.isArray(checks)) continue
    for (const entry of checks) {
      const check = object(entry)
      const id = check?.integration_id
      if (check?.context === 'review' && typeof id === 'number' && Number.isSafeInteger(id) && id > 0) ids.add(id)
    }
  }
  return ids.size === 1 ? ids.values().next().value : undefined
}
