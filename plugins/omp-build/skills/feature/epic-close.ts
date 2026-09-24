export type MergedChild = {
  number: number
  baseSha: string
  mergeSha: string | null
}

export function epicDiffRange(children: MergedChild[]): { range: string } | { error: string } {
  const merged = children.filter((child) => child.mergeSha)
  if (!merged.length) return { error: 'no merged children' }
  const first = merged[0]
  const last = merged[merged.length - 1]
  if (!first || !last?.mergeSha) return { error: 'no merged children' }
  return { range: `${first.baseSha}..${last.mergeSha}` }
}

export function postMergeHook(hook: string | null | undefined): { run: string } | { skip: string } {
  const trimmed = hook?.trim()
  if (!trimmed) return { skip: 'no release.post_merge — hook skipped' }
  return { run: trimmed }
}
