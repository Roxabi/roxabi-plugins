import { branchFor } from '../../skills/feature/epic-naming.ts'
import type { DecodedHistory } from '../history-schema.ts'
import type { Scope } from '../record-values.ts'
import type { UwGraphObservation } from '../uw-graph.ts'

type Declared = { uw: Scope; pullRequest: Scope; branch: string; head: string; base: string; merge: string }

export function parentDeliveryInventory(
  repository: string,
  parentScope: Scope,
  scopes: readonly Scope[],
  graph: Extract<UwGraphObservation, { status: 'complete' }>,
  declared: readonly Declared[],
  p0: string,
  merges: readonly string[],
  heads: readonly string[],
  parentHead: string,
) {
  const pullRequests = declared.map((entry) => ({
    scope: entry.pullRequest,
    branch: entry.branch,
    base: 'main',
    head: entry.head,
    baseTip: entry.base,
    state: 'MERGED' as const,
    mergeCommit: entry.merge,
    mergedAt: '2026-10-27T12:00:00Z',
    author: 'operator',
  }))
  const epic = {
    children: [
      { scope: parentScope, closedBy: [], timeline: [] },
      ...declared.map((entry, i) => ({
        scope: entry.uw,
        closedBy: [
          {
            number: 301 + i,
            state: 'MERGED' as const,
            baseRefName: 'main',
            headRefName: entry.branch,
            headRefOid: entry.head,
            mergedAt: '2026-10-27T12:00:00Z',
            mergeCommit: { oid: entry.merge, parents: { nodes: [{ oid: entry.base }] } },
            autoMergeRequest: null,
            labels: { nodes: [], pageInfo: { hasNextPage: false } },
            repository: { nameWithOwner: repository },
            isCrossRepository: false,
          },
        ],
        timeline: [],
      })),
    ],
    checks: [...new Set([p0, ...merges, ...heads, parentHead])].map((sha) => ({
      sha,
      nodes: [{ __typename: 'StatusContext' as const, context: 'fixture-ci', state: 'SUCCESS' }],
    })),
  }
  const candidateHeads = scopes.map((scope, index) => {
    const node = graph.nodes.find((item) => item.uw.target === scope.target)
    if (!node) throw new Error(`Missing child node ${scope.target}`)
    return branchFor({ number: 201 + index, title: node.title, labels: [...node.labels] })
  })
  const inventory = (children: typeof epic.children) => ({
    children,
    checks: epic.checks,
    branches: [...new Set([...candidateHeads, ...declared.map((entry) => entry.branch)])].map((head) => ({
      head,
      pulls: children
        .flatMap((child) => [...child.closedBy, ...child.timeline])
        .filter((pull) => pull.headRefName === head),
    })),
  })
  const deliveredEpic = inventory(epic.children)
  const unmanagedEpic = inventory(epic.children.map((child) => ({ ...child, closedBy: [], timeline: [] })))
  return { pullRequests, deliveredEpic, unmanagedEpic }
}

export function emptyDeliveryHistory(scope: Scope): DecodedHistory {
  return {
    source: {
      scope,
      expectedAuthor: 'operator',
      stopAuthor: 'operator',
      complete: true,
      comments: [],
      diagnostics: [],
    },
    operations: [],
    diagnostics: [],
  }
}
