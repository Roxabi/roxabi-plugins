import type { NativeEpicPullRequest } from '../adapters/github-native/epic-children.ts'
import type { Scope } from '../engine/record-values.ts'
import type { CheckNode } from '../skills/feature/epic-ci.ts'
import { nativeNumber, nativeReference } from './native-implementation-transport-graph.ts'
import type { NativeWorldFacts } from './native-implementation-world.ts'

export type NativeEpicFacts = {
  children: readonly {
    scope: Scope
    closedBy: readonly NativeEpicPullRequest[]
    timeline: readonly NativeEpicPullRequest[]
  }[]
  checks: readonly { sha: string; nodes: readonly CheckNode[] }[]
}

type EpicWorld = {
  repository: string
  graph: NativeWorldFacts['graph']
  pulls: Map<string, NativeWorldFacts['pullRequests'][number]>
  commits: Map<string, NativeWorldFacts['commits'][number]>
  facts: NativeEpicFacts
}

function validatePull(item: NativeEpicPullRequest, world: EpicWorld): void {
  const pull = world.pulls.get(`${world.repository}#${item.number}`)
  const merge = item.mergeCommit === null ? null : world.commits.get(item.mergeCommit.oid)
  if (
    !pull ||
    item.repository.nameWithOwner !== world.repository ||
    item.isCrossRepository ||
    item.state !== pull.state ||
    item.baseRefName !== pull.base ||
    item.headRefName !== pull.branch ||
    item.headRefOid !== pull.head ||
    (item.mergeCommit?.oid ?? null) !== pull.mergeCommit ||
    item.labels.pageInfo.hasNextPage
  )
    throw new Error('Epic PR enrichment conflicts with declared pull or commit')
  if (
    item.mergeCommit !== null &&
    (!merge ||
      item.mergeCommit.parents.nodes.length !== 1 ||
      item.mergeCommit.parents.nodes[0]?.oid !== merge.parents[0])
  )
    throw new Error('Epic PR enrichment conflicts with declared pull or commit')
}

function childFacts(world: EpicWorld, scope: Scope, closedLimit: number, timelineLimit: number) {
  const entries = world.facts.children.filter(
    (item) => item.scope.repository === scope.repository && item.scope.target === scope.target,
  )
  const entry = entries[0]
  if (entries.length !== 1 || !entry || entry.closedBy.length > closedLimit || entry.timeline.length > timelineLimit)
    throw new Error('Epic child enrichment was not declared completely')
  for (const item of [...entry.closedBy, ...entry.timeline]) validatePull(item, world)
  return entry
}

function branchResponse(world: EpicWorld, args: readonly string[]): string {
  const head = args[9]?.startsWith('head=') ? args[9].slice(5) : ''
  if (args[8] !== '-f' || !head) throw new Error('Invalid containment branch')
  const nodes = new Map<number, NativeEpicPullRequest>()
  for (const declared of world.facts.children) {
    const entry = childFacts(world, declared.scope, 100, 100)
    for (const item of [...entry.closedBy, ...entry.timeline])
      if (item.headRefName === head) nodes.set(item.number, item)
  }
  const actual = [...world.pulls.values()].filter((pull) => pull.branch === head)
  if (
    actual.length === 0 ||
    actual.length !== nodes.size ||
    actual.some((pull) => !nodes.has(nativeNumber(pull.scope))) ||
    nodes.size > 100
  )
    throw new Error('Containment branch inventory was not declared completely')
  return JSON.stringify({
    data: { repository: { pullRequests: { pageInfo: { hasNextPage: false }, nodes: [...nodes.values()] } } },
  })
}

function checkResponse(world: EpicWorld, args: readonly string[]): string {
  const sha = args[9]?.startsWith('sha=') ? args[9].slice(4) : ''
  const matches = world.facts.checks.filter((item) => item.sha === sha)
  if (args[8] !== '-f' || !world.commits.has(sha) || matches.length !== 1 || !matches[0])
    throw new Error('Commit rollup was not declared')
  if (matches[0].nodes.length > 100) throw new Error('Commit rollup exceeds declared page')
  return JSON.stringify({
    data: { repository: { object: { statusCheckRollup: { contexts: { nodes: matches[0].nodes } } } } },
  })
}

function containmentResponse(world: EpicWorld, args: readonly string[]): string {
  const number = args[9]?.startsWith('number=') ? Number(args[9].slice(7)) : NaN
  if (args[8] !== '-F' || !Number.isSafeInteger(number) || number <= 0) throw new Error('Invalid containment issue')
  const matches = world.graph.nodes.filter(
    (node) => node.uw.repository === world.repository && nativeNumber(node.uw) === number,
  )
  if (matches.length !== 1 || !matches[0]) throw new Error('Containment issue was not declared')
  const entry = childFacts(world, matches[0].uw, 100, 100)
  return JSON.stringify({
    data: {
      repository: {
        issue: {
          ...nativeReference(matches[0].uw),
          closedByPullRequestsReferences: { pageInfo: { hasNextPage: false }, nodes: entry.closedBy },
          timelineItems: {
            pageInfo: { hasPreviousPage: false },
            nodes: entry.timeline.map((source) => ({ source: { ...source, __typename: 'PullRequest' } })),
          },
        },
      },
    },
  })
}

function childrenResponse(world: EpicWorld, args: readonly string[]): string {
  const epic = args[9]?.startsWith('epic=') ? Number(args[9].slice(5)) : NaN
  if (args[8] !== '-F' || !Number.isSafeInteger(epic) || epic <= 0) throw new Error('Invalid Epic identity')
  const parent = world.graph.nodes.find(
    (node) => node.uw.repository === world.repository && nativeNumber(node.uw) === epic,
  )
  if (!parent || parent.children.length > 100) throw new Error('Epic child inventory was not declared completely')
  const nodes = parent.children.map((scope) => {
    const entry = childFacts(world, scope, 20, 50)
    return {
      ...nativeReference(scope),
      closedByPullRequestsReferences: { nodes: entry.closedBy },
      timelineItems: { nodes: entry.timeline.map((source) => ({ source })) },
    }
  })
  return JSON.stringify({ data: { repository: { issue: { subIssues: { pageInfo: { hasNextPage: false }, nodes } } } } })
}

function queryKind(query: string): 'children' | 'checks' | 'containment' | 'branch' | undefined {
  if (
    query.includes('closedByPullRequestsReferences(first: 20, includeClosedPrs: true)') &&
    query.includes('timelineItems(itemTypes: [CROSS_REFERENCED_EVENT], last: 50)')
  )
    return 'children'
  if (
    query.includes('statusCheckRollup { contexts(first: 100)') &&
    query.includes('... on StatusContext { context state }')
  )
    return 'checks'
  if (
    query.startsWith('query=query EpicContainmentIssue(') &&
    query.includes('closedByPullRequestsReferences(first: 100, includeClosedPrs: true)') &&
    query.includes('timelineItems(itemTypes: [CROSS_REFERENCED_EVENT], last: 100)')
  )
    return 'containment'
  if (
    query.startsWith('query=query EpicContainmentBranch(') &&
    query.includes('pullRequests(first: 100, headRefName: $head, states: [OPEN, CLOSED, MERGED])')
  )
    return 'branch'
  return undefined
}

/** Only explicitly declared Epic enrichment and commit rollups are observable. */
export function nativeEpicResponse(
  args: readonly string[],
  repository: string,
  graph: NativeWorldFacts['graph'],
  pulls: Map<string, NativeWorldFacts['pullRequests'][number]>,
  commits: Map<string, NativeWorldFacts['commits'][number]>,
  facts: NativeEpicFacts | undefined,
): string | undefined {
  if (args[0] !== 'api' || args[1] !== 'graphql' || args[2] !== '-f') return undefined
  const query = args[3]
  if (!query?.startsWith('query=')) return undefined
  const kind = queryKind(query)
  if (!kind) return undefined
  const [owner, name] = repository.split('/')
  if (
    args.length !== 10 ||
    args[4] !== '-f' ||
    args[5] !== `owner=${owner}` ||
    args[6] !== '-f' ||
    args[7] !== `name=${name}`
  )
    throw new Error('Undeclared Epic GraphQL repository or variables')
  if (!facts) throw new Error('Epic enrichment was not declared')
  const world = { repository, graph, pulls, commits, facts }
  if (kind === 'checks') return checkResponse(world, args)
  if (kind === 'containment') return containmentResponse(world, args)
  if (kind === 'branch') return branchResponse(world, args)
  return childrenResponse(world, args)
}
