import type { NativeWorldFacts } from './native-implementation-world.ts'

export function sisterDeclaredPull(
  args: string[],
  pulls: Map<string, NativeWorldFacts['pullRequests'][number]> | undefined,
): string | null {
  if (args[0] !== 'pr' || args[1] !== 'view') return null
  const pull = pulls?.get(`acme/app#${args[2]}`)
  if (pull)
    return JSON.stringify({
      number: Number(args[2]),
      state: pull.state,
      mergeCommit: pull.mergeCommit === null ? null : { oid: pull.mergeCommit },
      headRefOid: pull.head,
      headRefName: pull.branch,
      baseRefName: pull.base,
      baseRefOid: pull.baseTip,
      author: pull.author === null ? null : { login: pull.author },
    })
  return null
}

export function sisterCurrentPull(args: string[], currentPr: number, head: string, base: string): string | null {
  if (args[0] !== 'pr' || args[1] !== 'view') return null
  if (args[2] !== String(currentPr) && args[2] !== '44') return null
  return JSON.stringify({
    number: Number(args[2]),
    state: args[2] === '44' && currentPr !== 44 ? 'CLOSED' : 'OPEN',
    mergeCommit: null,
    headRefOid: head,
    headRefName: 'feat/42-save',
    baseRefName: 'main',
    baseRefOid: base,
    author: { login: 'automation' },
  })
}
