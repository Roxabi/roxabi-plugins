import { UW_GRAPH_QUERY } from '../adapters/github-native/uw-graph-query.ts'
import type { Scope } from '../engine/record-values.ts'
import type { NativeWorldFacts } from './native-implementation-world.ts'

export const nativeNumber = (scope: Scope) => Number(scope.target.slice(scope.target.lastIndexOf('#') + 1))
export const nativeReference = (scope: Scope) => ({
  number: nativeNumber(scope),
  repository: { nameWithOwner: scope.repository },
})
export const nativePage = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } })

export function nativeGraphResponse(
  args: readonly string[],
  repository: string,
  graph: NativeWorldFacts['graph'],
): string | undefined {
  const issueMatch = /^repos\/([^/]+\/[^/]+)\/issues\/([1-9][0-9]*)$/.exec(args[1] ?? '')
  if (args.length === 2 && args[0] === 'api' && issueMatch) {
    const number = Number(issueMatch[2])
    const node =
      issueMatch[1] === repository
        ? graph.nodes.find((item) => item.uw.repository === repository && nativeNumber(item.uw) === number)
        : undefined
    if (!node) throw new Error(`Undeclared native issue ${issueMatch[1]}#${number}`)
    return JSON.stringify({ number, state: node.native.state.toLowerCase(), body: node.raw.body, user: null })
  }
  if (
    args.length === 7 &&
    args[0] === 'issue' &&
    args[1] === 'view' &&
    args[3] === '--repo' &&
    args[4] === repository &&
    args[5] === '--json' &&
    args[6] === 'title,body,labels,updatedAt'
  ) {
    const number = Number(args[2])
    const node = graph.nodes.find((item) => item.uw.repository === repository && nativeNumber(item.uw) === number)
    if (!node) throw new Error(`Undeclared native issue ${number}`)
    return JSON.stringify({
      title: node.title,
      body: node.raw.body,
      labels: node.labels.map((name) => ({ name })),
      updatedAt: node.updatedAt,
    })
  }
  return nativeGraphqlResponse(args, repository, graph)
}

function nativeGraphqlResponse(
  args: readonly string[],
  repository: string,
  graph: NativeWorldFacts['graph'],
): string | undefined {
  const [owner, name] = repository.split('/')
  if (
    args.length === 10 &&
    args[0] === 'api' &&
    args[1] === 'graphql' &&
    args[2] === '-f' &&
    args[3] === `query=${UW_GRAPH_QUERY}` &&
    args[4] === '-f' &&
    args[5] === `owner=${owner}` &&
    args[6] === '-f' &&
    args[7] === `name=${name}` &&
    args[8] === '-F' &&
    args[9]?.startsWith('number=')
  ) {
    const number = Number(args[9].slice(7))
    const node = graph.nodes.find((item) => item.uw.repository === repository && nativeNumber(item.uw) === number)
    if (!node) throw new Error(`Undeclared native issue ${number}`)
    return JSON.stringify({
      data: {
        repository: {
          issue: {
            ...nativeReference(node.uw),
            title: node.title,
            body: node.raw.body,
            updatedAt: node.updatedAt,
            state: node.native.state,
            stateReason: node.native.stateReason,
            parent: node.parent === null ? null : nativeReference(node.parent),
            labels: nativePage(node.labels.map((name) => ({ name }))),
            subIssues: nativePage(node.children.map(nativeReference)),
            blockedBy: nativePage(node.blockers.map(nativeReference)),
          },
        },
      },
    })
  }
  return undefined
}
