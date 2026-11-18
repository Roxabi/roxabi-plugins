import { startImplement } from '../../roxabi/feature-action-start.ts'
import { loadContracts } from '../../roxabi/feature-engine.ts'
import { publishFeatureNativeResult } from '../../roxabi/feature-result.ts'
import { captureNativeTask } from '../../testing/native-action-capture.ts'
import type { DeclaredCheckout } from '../../testing/native-implementation-world.ts'
import {
  ancestorHistories,
  authenticatedIntegrationStart,
  integrationCompletions,
  requireIntegrationAction,
  type World,
} from '../../testing/parent-integration-observation.ts'
import { canonicalValueDigest } from '../action-input.ts'
import { criterionTargetSchema } from '../finding-target-schema.ts'
import { bindExternalRef, historyFor, recordsOf } from '../workflow-control.ts'

type Checkout = { cwd: string; checkout(commit: string): void; tree(commit: string): string }

/** Open, capture, and publish one parent integrate with an explicit original-execution current. */
export async function publishCapturedParentIntegration(
  world: World,
  checkout: Checkout,
  facts: {
    initial: DeclaredCheckout
    candidate: DeclaredCheckout
    command: string
    output: string
    current: () => boolean
    stop?: Parameters<typeof publishFeatureNativeResult>[0]['stop']
    beforePublication?: (input: { world: World; candidateHead: string }) => void
  },
) {
  const cwd = checkout.cwd
  const integrationBase = facts.initial.head
  world.checkout(facts.initial)
  checkout.checkout(integrationBase)
  const installed = world.operations
  const initial = await installed.readUw(world.parentScope)
  if (initial.observation.status !== 'complete' || initial.accepted.status !== 'accepted')
    throw new Error('Expected authenticated initial parent observation')
  const accepted = initial.accepted.value
  const completions = integrationCompletions(initial, world)
  const engine = await loadContracts()
  if ('missing' in engine) throw new Error(`Missing engine ${engine.missing}`)
  const history = initial.histories.find(
    (item) =>
      item.source.scope.target === world.parentScope.target &&
      item.source.scope.repository === world.parentScope.repository,
  )
  if (!history) throw new Error('Parent history missing')
  const native = initial.observation.graph.nodes.find(
    (item) => item.uw.target === world.parentScope.target && item.uw.repository === world.parentScope.repository,
  )
  if (!native) throw new Error('Parent native observation missing')
  const parents = ancestorHistories(initial, initial.observation.graph, native)
  const proposed = await startImplement(
    engine,
    {
      issue: history,
      pullRequest: null,
      parents,
      causal: {
        histories: initial.observation.histories,
        catalogues: initial.observation.catalogues,
        observation: initial.observation,
      },
    },
    history,
    world.parentScope,
    { body: native.raw.body },
    world.git,
    world.gh,
    cwd,
    world.parent,
    installed,
    new Set(),
  )
  const opened = requireIntegrationAction(proposed)
  const task = opened.followUp.tasks.tasks[0]
  if (!task) throw new Error('Missing opened native integration task')
  const boundStart = await authenticatedIntegrationStart(installed, world.parentScope, opened)
  const criteria = accepted.snapshot.spec.criteria
  if (criteria.length === 0) throw new Error('Parent producer requires direct criteria')
  const targets = criteria.map((criterion) =>
    criterionTargetSchema.parse({
      format: 'omp-build-finding-target/1',
      kind: 'criterion',
      spec: accepted.ref,
      id: criterion.id,
    }),
  )
  const code = { ...boundStart.payload.inputs.manifest.code, head: facts.candidate.head }
  const callId = 'integration-ownership-call'
  const model = {
    outcome: 'integrated' as const,
    code,
    children: completions.map((item) => ({ spec: item.spec, code: item.code, sources: [...item.sources] })),
    coverage: accepted.coverage,
    commands: [{ toolCallId: callId, command: facts.command, exitCode: 0 }],
    criteria: targets.map((target) => {
      const criterion = criteria.find((item) => item.id === target.id)
      if (!criterion) throw new Error('Parent criterion target is unavailable')
      return {
        target,
        verification: 'evidence' as const,
        evidence: [
          {
            id: `parent-test-${target.id}`,
            target,
            method: 'test' as const,
            scenario: criterion.statement,
            before: null,
            after: {
              toolCallId: callId,
              versionClaim: {
                code: { repository: code.repository, commit: code.head },
                reason: 'captured candidate',
                references: [],
              },
            },
          },
        ],
      }
    }),
    reason: 'integrated and checked',
  }
  world.checkout(facts.candidate)
  checkout.checkout(facts.candidate.head)
  const result = await captureNativeTask({
    batch: opened.followUp,
    cwd,
    childId: 'integration-ownership-child',
    command: facts.command,
    toolCallId: callId,
    output: facts.output,
    claim: model,
    expectedRuns: 1,
    git: { repository: code.repository, commit: code.head, tree: checkout.tree(code.head) },
  })
  facts.beforePublication?.({ world, candidateHead: facts.candidate.head })
  const publication = await publishFeatureNativeResult({
    cwd,
    start: opened.start,
    result,
    gh: world.gh,
    git: world.git,
    current: facts.current,
    ...(facts.stop === undefined ? {} : { stop: facts.stop }),
  })
  const after = await installed.readUw(world.parentScope)
  const receipt = after.histories
    .flatMap(recordsOf)
    .find(
      (record) =>
        record.kind === 'action-receipt' &&
        record.payload.action === 'integrate' &&
        record.payload.phase === 'result' &&
        record.payload.start.recordId === opened.start.recordId,
    )
  const startHistory = historyFor(opened.start.scope, after.histories)
  const startRecord = startHistory === null ? null : bindExternalRef(opened.start, startHistory)
  return {
    publication,
    receipt,
    after,
    opened,
    result,
    model,
    startRecord,
    digest: canonicalValueDigest(model),
  }
}
