import type { Gh } from '../adapters/github/types.ts'
import { canonicalValueDigest } from '../engine/action-input.ts'
import { integrationReceiptEligible } from '../engine/delivery-observation-authentication.ts'
import { criterionTargetSchema } from '../engine/finding-target-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import { scopeKey } from '../engine/uw-graph.ts'
import { integrationOutputSchema } from '../engine/uw-integration-schema.ts'
import type { MandateRecord } from '../engine/workflow-control.ts'
import { bindExternalRef, historyFor, workflowOperationProblem } from '../engine/workflow-control.ts'
import { startImplement } from '../roxabi/feature-action-start.ts'
import { loadContracts } from '../roxabi/feature-engine.ts'
import { publishFeatureNativeResult } from '../roxabi/feature-result.ts'
import type { UwOperations } from '../roxabi/uw-contract.ts'
import type { GitRunner } from '../roxabi/workflow-checkout.ts'
import { captureNativeTask } from './native-action-capture.ts'
import type { DeclaredCheckout } from './native-implementation-world.ts'

type World = {
  parentScope: Scope
  parent: MandateRecord
  reviews: readonly { uw: Scope }[]
  operations: UwOperations
  gh: Gh
  git: GitRunner
  checkout(facts: DeclaredCheckout): void
}
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
  const completions = world.reviews.map((child) => {
    const completion = initial.completion.completions.get(scopeKey(child.uw))
    if (completion?.state !== 'complete')
      throw new Error(
        JSON.stringify({
          child: child.uw,
          completion,
          histories: initial.histories.map((history) => ({
            scope: history.source.scope,
            complete: history.source.complete,
            problem: workflowOperationProblem(history),
            diagnostics: history.diagnostics,
            operations: history.operations.map((operation) => ({
              operationId: operation.operationId,
              recordId: operation.recordId,
              kind: operation.kind,
              status: operation.status,
              authority: operation.authority,
            })),
          })),
        }),
      )
    return completion
  })
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
  const ancestorHistories = () => {
    const parents = []
    let ancestor = native.parent
    while (ancestor !== null) {
      const currentAncestor = ancestor
      const node = graph.nodes.find(
        (item) => item.uw.target === currentAncestor.target && item.uw.repository === currentAncestor.repository,
      )
      const parent = initial.histories.find(
        (item) =>
          item.source.scope.target === currentAncestor.target &&
          item.source.scope.repository === currentAncestor.repository,
      )
      if (!node || !parent) throw new Error('Parent ancestor observation missing')
      parents.push(parent)
      ancestor = node.parent
    }
    return parents
  }
  const parents = ancestorHistories()
  const opened = await startImplement(
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
  )
  if (opened.kind !== 'action' || opened.node !== 'integrate')
    throw new Error(`Parent integrate not opened: ${JSON.stringify(opened)}`)
  const task = opened.followUp.tasks.tasks[0]
  if (!task) throw new Error('Missing opened native integration task')
  const startReadback = await installed.readUw(world.parentScope)
  const startHistory = historyFor(opened.start.scope, startReadback.histories)
  if (startHistory === null || !startHistory.source.complete)
    throw new Error('Integration START history is missing or incomplete')
  const boundStart = bindExternalRef(opened.start, startHistory)
  if (
    !boundStart.ok ||
    boundStart.value.kind !== 'action-receipt' ||
    boundStart.value.payload.action !== 'integrate' ||
    boundStart.value.payload.phase !== 'start'
  )
    throw new Error('Integration START is not authenticated')
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
  const code = { ...boundStart.value.payload.inputs.manifest.code, head: facts.candidate.head }
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
  const published = await publishFeatureNativeResult({ cwd, start: opened.start, result, gh: world.gh, git: world.git })
  if (!published.published || !('receipt' in published) || !published.receipt)
    throw new Error(`Integration not published: ${JSON.stringify(published)}`)
  const receiptRef = published.receipt
  const startRecord = boundStart.value
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
