import type { OperatorPort } from '../roxabi/uw-contract.ts'
import { standaloneReviewInputs } from './action-input-fixtures.ts'
import {
  type DeclaredCheckout,
  type NativeWorldFacts,
  withNativeImplementationWorld,
} from './native-implementation-world.ts'
import { nestedDeliverySpecifications } from './nested-delivery-world.ts'

/** Start with only framed mandates and independently declared native issue/Git observations. */
export async function withUnplannedInheritedWorld<T>(
  facts: {
    checkout: DeclaredCheckout
    commits: NativeWorldFacts['commits']
    comparisons: NativeWorldFacts['comparisons']
    diffs: readonly { base: string; head: string; bytes: Uint8Array }[]
    cwd?: string
    operator?: OperatorPort
  },
  use: (input: {
    world: Parameters<Parameters<typeof withNativeImplementationWorld>[1]>[0]
    scenario: ReturnType<typeof nestedDeliverySpecifications>
  }) => Promise<T>,
): Promise<T> {
  const scenario = nestedDeliverySpecifications()
  const { workflow, graph, leaf, rootMandate, middleMandate, leafMandate } = scenario
  const rootHistory = workflow.historyFrom([rootMandate])
  const middleHistory = workflow.historyFrom([middleMandate], 'operator', 'operator', [rootHistory])
  const leafHistory = workflow.historyFrom([leafMandate], 'operator', 'operator', [middleHistory, rootHistory])
  return withNativeImplementationWorld(
    {
      ...facts,
      plugin: standaloneReviewInputs().manifest.plugin,
      author: 'operator',
      graph,
      anchor: leaf,
      pullRequests: [],
      histories: [rootHistory, middleHistory, leafHistory],
    },
    async (world) => use({ world, scenario }),
  )
}
