import type { GitHubOptions } from '../adapters/github/types.ts'
import { createUwDeliveryFactReader } from '../adapters/github-workflow/uw-delivery-facts.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { ReviewClassCatalogues } from '../engine/review-class-catalogue.ts'
import type { UwCompletionObservation, UwDeliveryFacts } from '../engine/uw-completion-types.ts'
import { scopeKey, type UwGraphObservation } from '../engine/uw-graph.ts'
import { projectUwWaits } from '../engine/uw-waits.ts'

/** A declared simulated native world with an empty complete PR enumeration, not a delivery verdict. */
export async function observedUwWithoutPullRequests(input: {
  graph: Extract<UwGraphObservation, { status: 'complete' }>
  histories: readonly DecodedHistory[]
  catalogues: ReviewClassCatalogues
  /** Supply explicit simulated responses for any requested commit comparison. */
  otherGh?: NonNullable<GitHubOptions['gh']>
}): Promise<Extract<UwCompletionObservation, { status: 'complete' }>> {
  const reader = createUwDeliveryFactReader({
    cwd: '/simulated',
    readAuthor: 'operator',
    gh: async (cwd, args) => {
      if (args[0] === 'api' && args[1] === 'graphql')
        return JSON.stringify({
          data: { repository: { pullRequests: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } },
        })
      if (input.otherGh) return input.otherGh(cwd, args)
      throw new Error(`Simulated world did not declare native response for ${args.join(' ')}`)
    },
  })
  const histories = [...input.histories]
  const delivery: UwDeliveryFacts[] = []
  const waits = projectUwWaits({ graph: input.graph, histories, catalogues: input.catalogues })
  const graphScopes = new Set(input.graph.nodes.map((node) => scopeKey(node.uw)))
  const historyScopes = new Set(
    histories.filter((history) => history.source.complete).map((history) => scopeKey(history.source.scope)),
  )
  for (const scope of waits.requiredScopes) {
    const key = scopeKey(scope)
    if (!graphScopes.has(key) || !historyScopes.has(key))
      throw new Error(
        `Incomplete simulated UW closure for ${scope.repository} ${scope.target}: graph node and complete history are required`,
      )
  }
  for (const scope of waits.deliveryScopes) {
    const read = await reader.read(scope, histories)
    if (!read.ok) throw new Error(`Incomplete simulated delivery facts: ${JSON.stringify(read.diagnostics)}`)
    delivery.push(read.value.facts)
    for (const history of read.value.histories) if (!histories.includes(history)) histories.push(history)
  }
  return {
    status: 'complete',
    root: input.graph.root,
    graph: input.graph,
    histories,
    catalogues: input.catalogues,
    delivery,
  }
}
