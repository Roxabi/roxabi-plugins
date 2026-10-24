export type MergedChild = {
  number: number
  baseSha: string
  mergeSha: string | null
}

/** First merged child's base .. last merged child's merge commit, children in merge order. */
export function epicDiffRange(children: MergedChild[]): { range: string } | { error: string } {
  const merged = children.filter((child) => child.mergeSha)
  if (!merged.length) return { error: 'no merged children' }
  const first = merged[0]
  const last = merged[merged.length - 1]
  if (!first || !last?.mergeSha) return { error: 'no merged children' }
  return { range: `${first.baseSha}..${last.mergeSha}` }
}
