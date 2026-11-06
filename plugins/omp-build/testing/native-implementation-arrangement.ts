import type { DecodedHistory } from '../engine/history-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import type { MandateRecord } from '../engine/workflow-control.ts'
import { recordsOf } from '../engine/workflow-control.ts'
import { produceNativeImplementation } from './native-implementation-producer.ts'
import type {
  DeclaredCheckout,
  NativeWorldFacts,
  withNativeImplementationWorld,
} from './native-implementation-world.ts'

export type NativeImplementationInput = Omit<NativeWorldFacts, 'pullRequests'> & {
  scope: Scope
  mandate: MandateRecord
  startHead: string
  head: string
  branch: string
  baseTip: string
  remoteTipBefore: string | null
  remoteTipAfter: string | null
  pullRequestsBefore: NativeWorldFacts['pullRequests']
  pullRequestsAfter: NativeWorldFacts['pullRequests']
  command: string
  output: string
  criterion?: { verification: 'unverified'; reason: string }
}

function validatePulls(input: NativeImplementationInput) {
  const beforeKeys = new Set(input.pullRequestsBefore.map((pull) => `${pull.scope.repository}\0${pull.scope.target}`))
  const afterKeys = new Set(input.pullRequestsAfter.map((pull) => `${pull.scope.repository}\0${pull.scope.target}`))
  if (
    beforeKeys.size !== input.pullRequestsBefore.length ||
    afterKeys.size !== input.pullRequestsAfter.length ||
    beforeKeys.size !== afterKeys.size ||
    [...beforeKeys].some((key) => !afterKeys.has(key))
  )
    throw new Error('Implementation PR observations must have the same unique scopes before and after')
  for (const pull of input.pullRequestsBefore)
    if (pull.branch === input.branch && pull.head !== input.remoteTipBefore)
      throw new Error('Initial PR head disagrees with its declared remote branch tip')
  for (const pull of input.pullRequestsAfter)
    if (pull.branch === input.branch && pull.head !== input.remoteTipAfter)
      throw new Error('Final PR head disagrees with its declared remote branch tip')
}

function ancestorHistories(input: NativeImplementationInput, histories: readonly DecodedHistory[]) {
  const parents: DecodedHistory[] = []
  let node = input.graph.nodes.find(
    (item) => item.uw.repository === input.scope.repository && item.uw.target === input.scope.target,
  )
  while (node?.parent) {
    const ancestor = node.parent
    const parent = histories.find(
      (item) => item.source.scope.repository === ancestor.repository && item.source.scope.target === ancestor.target,
    )
    if (!parent) throw new Error('Declared ancestor history is missing')
    parents.push(parent)
    node = input.graph.nodes.find(
      (item) => item.uw.repository === ancestor.repository && item.uw.target === ancestor.target,
    )
  }
  return parents
}

export async function arrangeNativeImplementation(
  input: NativeImplementationInput,
  withWorld: typeof withNativeImplementationWorld,
) {
  const producedCommit = input.commits.find((commit) => commit.sha === input.head)
  if (!producedCommit) throw new Error('Missing declared implementation commit')
  const planStart = input.histories
    .flatMap(recordsOf)
    .find(
      (record) =>
        record.kind === 'action-receipt' &&
        record.repository === input.scope.repository &&
        record.target === input.scope.target &&
        record.payload.action === 'plan' &&
        record.payload.phase === 'start',
    )
  if (planStart?.kind !== 'action-receipt') throw new Error('Implementation requires a declared plan START')
  validatePulls(input)
  const initial: DeclaredCheckout = {
    branch: input.branch,
    head: input.startHead,
    base: input.mandate.payload.base,
    baseTip: input.baseTip,
    remoteTip: input.remoteTipBefore,
  }
  return withWorld(
    {
      ...input,
      plugin: planStart.payload.inputs.manifest.plugin,
      pullRequests: input.pullRequestsBefore,
      anchor: input.scope,
      checkout: initial,
      diffs: [],
    },
    async (world) => {
      const before = await world.operations.readUw(input.scope)
      const parents = ancestorHistories(input, before.histories)
      const produced = await produceNativeImplementation({
        cwd: world.cwd,
        gh: world.gh,
        git: world.git,
        operations: world.operations,
        read: before,
        scope: input.scope,
        mandate: input.mandate,
        parents,
        startHead: input.startHead,
        command: input.command,
        output: input.output,
        ...(input.criterion === undefined ? {} : { criterion: input.criterion }),
        advance() {
          world.checkout({ ...initial, head: input.head, remoteTip: input.remoteTipAfter })
          for (const pull of input.pullRequestsAfter) world.observePullRequest(pull)
          return { head: input.head, tree: producedCommit.tree }
        },
      })
      if (!produced.history) throw new Error('Published implementation history missing')
      return { ...produced, records: recordsOf(produced.history) }
    },
  )
}
