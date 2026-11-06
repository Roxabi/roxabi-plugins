import type { Gh } from '../adapters/github/types.ts'
import { fixtureCatalogueGhResponse } from './action-input-fixtures.ts'
import { createNativeComments } from './native-implementation-transport-comments.ts'
import { type NativeEpicFacts, nativeEpicResponse } from './native-implementation-transport-epic.ts'
import { nativeGraphResponse } from './native-implementation-transport-graph.ts'
import { nativeCommitResponse, nativePullResponse } from './native-implementation-transport-pulls.ts'
import type { NativeWorldFacts } from './native-implementation-world.ts'

export function createNativeImplementationTransport(input: {
  repository: string
  originUrl?: string
  epic?: NativeEpicFacts
  author: string
  histories: NativeWorldFacts['histories']
  graph: NativeWorldFacts['graph']
  commits: Map<string, NativeWorldFacts['commits'][number]>
  pulls: Map<string, NativeWorldFacts['pullRequests'][number]>
  comparisons: Map<string, NativeWorldFacts['comparisons'][number]>
}) {
  const { repository, commits, pulls, comparisons } = input
  const comments = createNativeComments(repository, input.author, input.histories)
  let graph = input.graph
  function repositoryResponse(args: readonly string[]): string {
    const reference = args[2]
    if (
      reference !== undefined &&
      !reference.startsWith('-') &&
      reference !== repository &&
      reference !== input.originUrl
    )
      throw new Error(`Undeclared repository reference ${reference}`)
    const jq = args.indexOf('--jq')
    if (jq === -1) return JSON.stringify({ nameWithOwner: repository })
    if (args[jq + 1] !== '.nameWithOwner') throw new Error('Undeclared repository projection')
    return repository
  }
  function identityResponse(args: readonly string[]): string | undefined {
    if (args[0] === 'api' && args[1] === 'user') return input.author
    if (args[0] === 'repo' && args[1] === 'view') return repositoryResponse(args)
    return undefined
  }
  const ghSync = (_cwd: string, args: string[]): string => {
    const responders = [
      () => fixtureCatalogueGhResponse(args) ?? undefined,
      () => identityResponse(args),
      () => nativeEpicResponse(args, repository, graph, pulls, commits, input.epic),
      () => nativeGraphResponse(args, repository, graph),
      () => comments.response(args),
      () => nativePullResponse(args, repository, pulls),
      () => nativeCommitResponse(args, repository, commits, comparisons),
    ]
    for (const respond of responders) {
      const response = respond()
      if (response !== undefined) return response
    }
    throw new Error(`Undeclared GitHub request ${args.join(' ')}`)
  }
  const gh: Gh = async (cwd, args) => ghSync(cwd, args)
  function observeGraph(next: NativeWorldFacts['graph']): void {
    if (
      next.root.repository !== repository ||
      next.nodes.some((node) => node.uw.repository !== repository || !comments.has(node.uw))
    )
      throw new Error('Graph observation refers to an undeclared native scope')
    graph = next
  }
  function observePullRequest(facts: NativeWorldFacts['pullRequests'][number]): void {
    if (
      facts.scope.repository !== repository ||
      !comments.has(facts.scope) ||
      !commits.has(facts.head) ||
      !commits.has(facts.baseTip) ||
      (facts.mergeCommit !== null && !commits.has(facts.mergeCommit))
    )
      throw new Error('Pull request observation has undeclared history or commits')
    pulls.set(facts.scope.target, facts)
  }
  return { gh, ghSync, observeGraph, observePullRequest, editComment: comments.editComment }
}
