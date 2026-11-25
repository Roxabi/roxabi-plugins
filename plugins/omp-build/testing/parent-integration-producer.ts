import type { Gh } from '../adapters/github/types.ts'
import { actionInputDigest, canonicalValueDigest } from '../engine/action-input.ts'
import type { ActionInputs } from '../engine/action-input-schema.ts'
import { completeCriterionDeclarations } from '../engine/criterion-declaration-completion.ts'
import { integrationReceiptEligible } from '../engine/delivery-observation-authentication.ts'
import { criterionTargetSchema } from '../engine/finding-target-schema.ts'
import type { ExternalRecordRef } from '../engine/record-references.ts'
import type { Scope } from '../engine/record-values.ts'
import { scopeKey } from '../engine/uw-graph.ts'
import { type IntegrationOutput, integrationOutputSchema } from '../engine/uw-integration-schema.ts'
import type { MandateRecord } from '../engine/workflow-control.ts'
import { bindExternalRef, historyFor, workflowOperationProblem } from '../engine/workflow-control.ts'
import type { UwOperations, UwRead } from '../roxabi/uw-contract.ts'
import type { GitRunner } from '../roxabi/workflow-checkout.ts'
import { historicalCommandCapture } from './native-action-capture.ts'
import { appendNativeReceipt, historicalAcceptedInputs, openHistoricalDelivery } from './native-history-records.ts'
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

/** Bind a historical integration review to the exact result and its criterion declarations. */
export function historicalIntegrationReviewInputs(
  read: UwRead,
  mandate: MandateRecord,
  record: ExternalRecordRef,
  output: IntegrationOutput,
): ActionInputs {
  const inputs = historicalAcceptedInputs(read, mandate, 'review', {
    ...output.code,
    referenceCommit: output.code.head,
  })
  const manifest = {
    ...inputs.manifest,
    deliveryData: [
      {
        source: 'record' as const,
        role: 'integration' as const,
        record,
        selector: '/payload/structured/code',
        digest: canonicalValueDigest(output.code),
      },
      ...output.criteria.map((criterion, index) => ({
        source: 'record' as const,
        role: 'implementation' as const,
        record,
        selector: `/payload/structured/criteria/${index}`,
        digest: canonicalValueDigest(criterion),
      })),
    ],
  }
  return { ...inputs, manifest, fingerprint: actionInputDigest(manifest) }
}

/** Seed and read back historical parent integration against the declared Git observation. */
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
  const { parentScope: scope, parent: mandate } = world
  const historical = { cwd, gh: world.gh, operations: installed }
  const opened = await openHistoricalDelivery({
    world: historical,
    scope,
    mandate,
    read: initial,
    action: 'integrate',
    childProofs: completions.flatMap((child) => child.sources),
    code: {
      repository: scope.repository,
      base: facts.initial.baseTip,
      head: integrationBase,
      referenceCommit: integrationBase,
    },
  })
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
  const code = { ...opened.authority.inputs.manifest.code, head: facts.candidate.head }
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
  const capture = historicalCommandCapture({
    actionId: opened.authority.actionId,
    cwd,
    childId: 'integration-native-child',
    command,
    toolCallId: callId,
    output: facts.output,
    claim: model,
    git: { repository: code.repository, commit: code.head, tree: checkout.tree(code.head) },
  })
  const remote = await world.git(cwd, ['ls-remote', 'origin', `refs/heads/${facts.candidate.base}`])
  const remoteTip = remote.stdout.trim().split(/\s+/)[0] ?? ''
  if (remote.code !== 0 || remoteTip !== code.head) throw new Error('Historical integration candidate is unpublished')
  const range = await world.git(cwd, ['rev-list', '--first-parent', '--reverse', `${integrationBase}..${code.head}`])
  if (range.code !== 0) throw new Error('Integration lineage is unavailable')
  const commits = range.stdout.trim().split(/\s+/).filter(Boolean)
  const paths = await Promise.all(
    commits.map(async (commit) => {
      const diff = await world.git(cwd, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-m', commit])
      if (diff.code !== 0) throw new Error(`Integration paths unavailable: ${commit}`)
      return diff.stdout.trim().split('\n').filter(Boolean)
    }),
  )
  const { ref: receiptRef } = await appendNativeReceipt(historical, scope, {
    ...opened.authority,
    action: 'integrate',
    phase: 'result',
    start: opened.start,
    structured: integrationOutputSchema.parse({
      ...model,
      criteria: completeCriterionDeclarations(model.criteria, capture),
    }),
    native: capture.native,
    admission: {
      admitted: true,
      commits,
      paths: [...new Set(paths.flat())].sort(),
      commands: model.commands.map((item) => ({ ...item, cwd })),
      remoteBranch: null,
      remoteTip,
      published: true,
      reason: model.reason,
    },
    diagnostics: [],
  })
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
      canonicalValueDigest(payload.inputs) !== canonicalValueDigest(opened.authority.inputs) ||
      canonicalValueDigest(payload.exactInputs) !== canonicalValueDigest(opened.authority.exactInputs) ||
      canonicalValueDigest(payload.start) !== canonicalValueDigest(opened.start)
    )
      throw new Error(
        `Integration retained but not admitted and bound: ${JSON.stringify({ receipt: receipt.payload, remote })}`,
      )
    return { beforeReview, receipt, output: output.data }
  }
  const { beforeReview, receipt, output } = await readIntegratedResult()
  const integrationPin = {
    source: 'record' as const,
    record: receiptRef,
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
    integrationRecordId: receiptRef.recordId,
    beforeReview,
    receipt,
    output,
    integrationPin,
  }
}
