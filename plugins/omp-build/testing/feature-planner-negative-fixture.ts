import type { NativeBatchResult } from '../omp/review-runtime/contracts.ts'
import type { HostGitIdentity } from '../omp/review-runtime/host-git-observation.ts'
import type { ContinueFeatureInput, FeatureNativePublication } from '../roxabi/feature-contract.ts'
import { publishFeatureNativeResult } from '../roxabi/feature-result.ts'
import { continueFeature } from '../roxabi/workflow.ts'
import { consultableAgentRoot } from './protocol-retention.unit.ts'
import { bridgeHarness } from './review-runtime-support.ts'

/** Start and publish a native planner context negative using the caller's real world ports. */
export async function publishNativePlanNegative(input: ContinueFeatureInput, identity: HostGitIdentity) {
  const selected = await continueFeature(input)
  if (selected.kind !== 'action' || selected.node !== 'plan')
    throw new Error(`Planner negative start unavailable: ${JSON.stringify(selected)}`)
  const task = selected.followUp.tasks.tasks[0]
  if (task === undefined) throw new Error('Planner negative task unavailable')
  const harness = bridgeHarness()
  harness.controller.bindHostGit(() => identity)
  const root = { ...consultableAgentRoot(), cwd: input.cwd }
  const output = {
    outcome: 'missing-context',
    missing: [
      {
        locator: { kind: 'information-request', description: 'Deployment region' },
        reason: 'Not in the supplied context',
        targets: [],
      },
    ],
  }
  let published: FeatureNativePublication | null = null
  let retained: NativeBatchResult | null = null
  harness.controller.activate(selected.followUp, {
    onComplete: () => {
      throw new Error('Negative completed positively')
    },
    onStop: async (_reason, result, stop) => {
      if (result === null || stop.kind !== 'context-negative')
        throw new Error('Native planner negative was not retained')
      retained = result
      published = await publishFeatureNativeResult({
        cwd: input.cwd,
        start: selected.start,
        result,
        stop,
        gh: input.gh,
        git: input.git,
        current: () => true,
      })
    },
  })
  const call = selected.followUp.operationId
  if (!(await harness.admitBatch(selected.followUp, call, root))) throw new Error('Native planner admission refused')
  await harness.admitChild(selected.followUp, task.name, 'planner-negative-child', {
    toolCallId: call,
    root,
    skipRootCall: true,
  })
  await harness.yieldChild('planner-negative-child', output)
  await harness.settleBatch({
    toolCallId: call,
    errors: [],
    results: [
      {
        index: 0,
        id: 'planner-negative-child',
        agent: task.agent,
        exitCode: 0,
        structuredOutput: { status: 'valid', data: output },
      },
    ],
  })
  const publication = published as FeatureNativePublication | null
  if (publication === null || !publication.published || publication.receipt === undefined)
    throw new Error(`Planner negative publication refused: ${JSON.stringify(publication)}`)
  return { selected, result: retained, published: publication }
}
