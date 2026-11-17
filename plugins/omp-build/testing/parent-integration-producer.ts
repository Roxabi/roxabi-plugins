import { canonicalValueDigest } from '../engine/action-input.ts'
import { integrationReceiptEligible } from '../engine/delivery-observation-authentication.ts'
import { criterionTargetSchema } from '../engine/finding-target-schema.ts'
import { integrationOutputSchema } from '../engine/uw-integration-schema.ts'
import { bindExternalRef, controlsOf, historyFor } from '../engine/workflow-control.ts'
import { startImplement } from '../roxabi/feature-action-start.ts'
import type { ContinueFeatureResult, FeatureNativePublication } from '../roxabi/feature-contract.ts'
import { loadContracts } from '../roxabi/feature-engine.ts'
import { publishFeatureNativeResult } from '../roxabi/feature-result.ts'
import { captureNativeTask } from './native-action-capture.ts'
import type { DeclaredCheckout } from './native-implementation-world.ts'
import {
  ancestorHistories,
  authenticatedIntegrationStart,
  integrationCompletions,
  requireIntegrationAction,
  type World,
} from './parent-integration-observation.ts'
import { consultableAgentRoot } from './protocol-retention.unit.ts'
import { bridgeHarness } from './review-runtime-support.ts'

type Checkout = { cwd: string; checkout(commit: string): void; tree(commit: string): string }

/** Produce and read back the real parent integration while the caller owns the native world. */
export async function produceParentIntegration(
  world: World,
  checkout: Checkout,
  facts: {
    initial: DeclaredCheckout
    candidate: DeclaredCheckout
    command: string
    output: string
    observeStart?: (opened: ContinueFeatureResult) => void
    open?: () => Promise<ContinueFeatureResult>
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
  const graph = initial.observation.graph
  const parents = ancestorHistories(initial, graph, native)
  if (
    !facts.open &&
    controlsOf(history).some(
      (control) =>
        control.payload.control === 'select-successor' &&
        control.payload.successor.recordId === world.parent.recordId &&
        control.payload.contextDisposition !== undefined,
    )
  )
    throw new Error('Successor integration requires authenticated current context succession')
  const proposed = facts.open
    ? await facts.open()
    : await startImplement(
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
  facts.observeStart?.(proposed)
  const opened = requireIntegrationAction(proposed)
  const task = opened.followUp.tasks.tasks[0]
  if (!task) throw new Error('Missing opened native integration task')
  const boundStart = await authenticatedIntegrationStart(installed, world.parentScope, opened)
  function directCriteria() {
    const criteria = accepted.snapshot.spec.criteria
    if (criteria.length === 0) throw new Error('Parent producer requires direct criteria')
    return criteria
  }
  const criteria = directCriteria()
  const targets = criteria.map((criterion) =>
    criterionTargetSchema.parse({
      format: 'omp-build-finding-target/1',
      kind: 'criterion',
      spec: accepted.ref,
      id: criterion.id,
    }),
  )
  const code = { ...boundStart.payload.inputs.manifest.code, head: facts.candidate.head }
  const callId = 'integration-test-call'
  const command = facts.command
  const model = {
    outcome: 'integrated' as const,
    code,
    children: completions.map((item) => ({ spec: item.spec, code: item.code, sources: [...item.sources] })),
    coverage: accepted.coverage,
    commands: [{ toolCallId: callId, command, exitCode: 0 }],
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
  let publication: FeatureNativePublication | null = null
  if (facts.open) {
    const harness = bridgeHarness()
    harness.controller.bindHostGit(() => ({
      repository: code.repository,
      commit: code.head,
      tree: checkout.tree(code.head),
    }))
    harness.controller.activate(opened.followUp, {
      onComplete: async (result) => {
        publication = await publishFeatureNativeResult({
          cwd,
          start: opened.start,
          result,
          gh: world.gh,
          git: world.git,
        })
      },
      onStop: async (reason) => {
        throw new Error(`Parent integration stopped: ${reason}`)
      },
    })
    const root = { ...consultableAgentRoot(), cwd }
    const operation = opened.followUp.operationId
    if (!(await harness.admitBatch(opened.followUp, operation, root)))
      throw new Error('Parent integration admission refused')
    const child = await harness.admitChild(opened.followUp, task.name, 'integration-native-child', {
      toolCallId: operation,
      root,
      skipRootCall: true,
    })
    await child.call('bash', callId, { command })
    await child.result(
      'bash',
      callId,
      { command },
      { content: [{ type: 'text', text: facts.output }], details: { exitCode: 0 }, isError: false },
    )
    await harness.yieldChild('integration-native-child', model)
    await harness.settleBatch({
      toolCallId: operation,
      errors: [],
      results: [
        {
          index: 0,
          id: 'integration-native-child',
          agent: task.agent,
          exitCode: 0,
          structuredOutput: { status: 'valid', data: model },
        },
      ],
    })
  } else {
    const result = await captureNativeTask({
      batch: opened.followUp,
      cwd,
      childId: 'integration-native-child',
      command,
      toolCallId: callId,
      output: facts.output,
      claim: model,
      expectedRuns: 1,
      git: { repository: code.repository, commit: code.head, tree: checkout.tree(code.head) },
    })
    publication = await publishFeatureNativeResult({ cwd, start: opened.start, result, gh: world.gh, git: world.git })
  }
  const published = publication as FeatureNativePublication | null
  if (!published?.published || !('receipt' in published) || !published.receipt)
    throw new Error(`Integration not published: ${JSON.stringify(published)}`)
  const receiptRef = published.receipt
  const startRecord = boundStart
  const startRef = opened.start
  const readIntegratedResult = async () => {
    const beforeReview = await installed.readUw(world.parentScope)
    if (beforeReview.observation.status !== 'complete' || beforeReview.accepted.status !== 'accepted')
      throw new Error('Post-integration observation unavailable')
    const authenticatedResult = () => {
      const resultHistory = historyFor(receiptRef.scope, beforeReview.histories)
      if (resultHistory === null || !resultHistory.source.complete)
        throw new Error('Integration result history is incomplete')
      const boundResult = bindExternalRef(receiptRef, resultHistory)
      if (
        !boundResult.ok ||
        boundResult.value.kind !== 'action-receipt' ||
        boundResult.value.payload.action !== 'integrate' ||
        boundResult.value.payload.phase !== 'result'
      )
        throw new Error(`Integration result is not authenticated: ${JSON.stringify(boundResult)}`)
      const receipt = boundResult.value
      if (receipt.payload.action !== 'integrate' || receipt.payload.phase !== 'result')
        throw new Error('Authenticated integration receipt has the wrong action or phase')
      return { receipt, payload: receipt.payload }
    }
    const { receipt, payload } = authenticatedResult()
    const output = integrationOutputSchema.safeParse(payload.structured)
    const remote = await world.git(cwd, ['ls-remote', 'origin', `refs/heads/${facts.candidate.base}`])
    const remoteTip = remote.stdout.trim().split(/\s+/)[0] ?? ''
    if (
      !integrationReceiptEligible(receipt) ||
      payload.admission?.admitted !== true ||
      payload.admission.remoteBranch !== facts.candidate.branch ||
      payload.admission.remoteTip !== facts.candidate.head ||
      remote.code !== 0 ||
      remoteTip !== facts.candidate.head ||
      !output.success ||
      canonicalValueDigest(output.data.code) !== canonicalValueDigest(code) ||
      canonicalValueDigest(payload.inputs) !== canonicalValueDigest(startRecord.payload.inputs) ||
      canonicalValueDigest(payload.exactInputs) !== canonicalValueDigest(startRecord.payload.exactInputs) ||
      canonicalValueDigest(payload.start) !== canonicalValueDigest(startRef)
    )
      throw new Error(
        `Integration retained but not admitted and bound: ${JSON.stringify({ receipt: receipt.payload, remote })}`,
      )
    return { beforeReview, receipt, output: output.data }
  }
  const { beforeReview, receipt, output } = await readIntegratedResult()
  const integrationPin = {
    source: 'record' as const,
    record: published.receipt,
    selector: '/payload/structured/code',
    digest: canonicalValueDigest(output.code),
  }
  return {
    cwd,
    installed,
    initial,
    completions,
    opened,
    targets,
    code: output.code,
    integrationRecordId: published.receipt.recordId,
    beforeReview,
    receipt,
    output,
    integrationPin,
  }
}
