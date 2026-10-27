export function acceptanceCriteria(body: string): string[] {
  const lines = body.split('\n')
  const start = lines.findIndex((line) => /^#{1,6}\s+acceptance criteria\s*$/i.test(line.trim()))
  if (start < 0) return []
  const items: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s+/.test(line.trim())) break
    const item = /^[-*]\s+(.+)$/.exec(line.trim())
    if (item?.[1]) items.push(item[1].trim())
  }
  return items
}
