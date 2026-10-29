export function cites(value: unknown, found: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) cites(item, found)
    return
  }
  if (value === null || typeof value !== 'object') return
  const body = value as Record<string, unknown>
  if (typeof body.recordId === 'string' && typeof body.kind === 'string') found.add(body.recordId)
  for (const item of Object.values(body)) cites(item, found)
}
