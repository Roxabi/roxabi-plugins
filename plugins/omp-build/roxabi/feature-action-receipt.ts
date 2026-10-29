import { randomUUID } from 'node:crypto'
import { mechanicalSpecDelta } from '../dist/contracts.js'
import type { FailedCheckFailure } from '../engine/record-digests.ts'
import type { Scope } from '../engine/record-values.ts'
import type { AssessSpecExact } from '../engine/workflow-receipt-schema.ts'
import {
  actionRequest,
  blocks,
  codePin,
  confirmStartReadback,
  observeHeadCode,
  observeSha,
  prepareDeliveryAction,
  prepareRefusal,
  uwSubject,
} from './delivery-action.ts'
import { preparedModelAction } from './feature-action-prompts.ts'
import { approvedMandateContext } from './feature-approved-context.ts'
import { readNativeCiFailureEvidence } from './feature-ci-evidence.ts'
import type { ContinueFeatureResult } from './feature-contract.ts'
import { type Contracts, type History, publishRecord, type WorkflowEvidence } from './feature-engine.ts'
import type { PreparedUwAction } from './uw-action-contract.ts'
import type { UwOperations } from './uw-contract.ts'
import type { GitRunner } from './workflow-checkout.ts'

export type Gh = (cwd: string, args: string[]) => Promise<string>

export type ModelReceiptActionInput = {
  action: 'assess-spec' | 'attribute-ci'
  loaded: Contracts
  history: History
  mandateHistory?: History
  mandate: NonNullable<History['operations'][number]['record']>
  evidence: WorkflowEvidence
  scope: Scope
  currentSpec: AssessSpecExact['proposed'] | null
  identityAllocations: AssessSpecExact['identityAllocations'] | null
  target:
    | { status: 'issue'; scope: Scope; issue: { number: number } }
    | { status: 'pull-request'; scope: Scope; pullRequest: { pr: number; head: string; base: string; branch: string } }
  gh: Gh
  cwd: string
  uw: UwOperations | undefined
  git: GitRunner
}

type ReceiptStartContext = {
  mandateHistory: History
  mandateScope: Scope
  operationId: string
}

export function receiptStartContext(input: ModelReceiptActionInput): ReceiptStartContext {
  return {
    mandateHistory: input.mandateHistory ?? input.history,
    mandateScope: { repository: input.mandate.repository, target: input.mandate.target },
    operationId: randomUUID(),
  }
}

export async function sealReceipt(
  input: {
    loaded: Contracts
    history: History
    scope: Scope
    cwd: string
    gh: Gh
    parents: readonly History[]
    operationId: string
    mandate: { scope: Scope; recordId: string; kind: 'mandate' }
    prepared: PreparedUwAction
  } & (
    | { action: 'assess-spec'; exactInputs: AssessSpecExact }
    | {
        action: 'attribute-ci'
        exactInputs: {
          candidateGitSHA: string
          scope: Scope
          failedChecks: string[]
          evidenceDigest: string
          failures: FailedCheckFailure[]
        }
      }
    | { action: 'implement'; exactInputs: { mandateId: string; planActionId: string } }
  ),
): Promise<ContinueFeatureResult> {
  const startId = randomUUID()
  const base = {
    format: 'omp-build-action-receipt/2' as const,
    phase: 'start' as const,
    actionId: input.operationId,
    mandate: input.mandate,
    inputs: input.prepared.inputs,
  }
  const payload =
    input.action === 'assess-spec'
      ? { ...base, action: input.action, exactInputs: input.exactInputs }
      : input.action === 'attribute-ci'
        ? { ...base, action: input.action, exactInputs: input.exactInputs }
        : { ...base, action: input.action, exactInputs: input.exactInputs }
  const started = await publishRecord(
    input.loaded,
    input.history,
    {
      repository: input.scope.repository,
      target: input.scope.target,
      version: 1,
      recordId: startId,
      runId: randomUUID(),
      operationId: input.operationId,
      kind: 'action-receipt',
      payload,
    },
    input.gh,
    input.cwd,
    input.parents,
  )
  if (!started.ok) return { kind: 'blocked', reason: started.reason, diagnostics: started.diagnostics }
  const confirmed = await confirmStartReadback({
    read: (scopes) => input.loaded.readComposedWorkflowHistory(scopes, { cwd: input.cwd, gh: input.gh }),
    scope: input.scope,
    recordId: startId,
    inputs: input.prepared.inputs,
  })
  if (!confirmed.ok) return blocks(confirmed.reason)
  return preparedModelAction({
    action: input.action,
    scope: input.scope,
    start: { scope: input.scope, recordId: startId, kind: 'action-receipt' },
    operationId: input.operationId,
    prepared: input.prepared,
  })
}

async function publishAssessmentReceipt(
  input: ModelReceiptActionInput,
  context: ReceiptStartContext,
  exactInputs: AssessSpecExact,
): Promise<ContinueFeatureResult> {
  const code = await observeHeadCode(input.git, input.cwd, input.scope.repository)
  if (!code.ok) return blocks(code.reason)
  if (input.uw === undefined) return blocks('prepare-action-unavailable')
  const prepared = await prepareDeliveryAction(
    input.uw,
    actionRequest({
      actionId: context.operationId,
      purpose: 'assess-spec',
      subject: uwSubject(context.mandateScope, input.target.status === 'pull-request' ? input.target.scope : null),
      code: code.code,
    }),
  )
  if (!prepared.ok) return blocks(prepareRefusal(prepared.diagnostics), prepared.diagnostics)
  return sealReceipt({
    loaded: input.loaded,
    history: input.history,
    scope: input.scope,
    cwd: input.cwd,
    gh: input.gh,
    parents: input.evidence.parents,
    operationId: context.operationId,
    action: 'assess-spec',
    mandate: { scope: context.mandateScope, recordId: input.mandate.recordId, kind: 'mandate' },
    exactInputs,
    prepared: prepared.value,
  })
}

export async function startAssessmentReceipt(
  input: ModelReceiptActionInput,
  context: ReceiptStartContext,
): Promise<ContinueFeatureResult> {
  if (input.mandate.kind !== 'mandate' || input.currentSpec === null || input.identityAllocations === null)
    return { kind: 'blocked', reason: 'mandate-spec-missing' }
  const accepted = input.loaded.resolveAcceptedSpec(input.mandate, [context.mandateHistory, ...input.evidence.parents])
  if (!accepted.ok) return { kind: 'blocked', reason: 'mandate-spec-missing' }
  return publishAssessmentReceipt(input, context, {
    format: 'omp-build-spec-assessment/2',
    accepted: {
      ref: accepted.spec.ref,
      snapshot: accepted.spec.snapshot,
      tier: accepted.spec.tier,
      children: accepted.spec.children,
    },
    proposed: input.currentSpec,
    identityAllocations: input.identityAllocations,
    mechanical: mechanicalSpecDelta(
      {
        snapshot: accepted.spec.snapshot,
        tier: accepted.spec.tier,
        children: accepted.spec.children,
      },
      input.currentSpec,
    ),
  })
}

function ciPublicationParents(input: ModelReceiptActionInput, mandateHistory: History): readonly History[] {
  const mandateIsPrimary =
    input.history.source.scope.repository === mandateHistory.source.scope.repository &&
    input.history.source.scope.target === mandateHistory.source.scope.target
  const mandateIsParent = input.evidence.parents.some(
    (history) =>
      history.source.scope.repository === mandateHistory.source.scope.repository &&
      history.source.scope.target === mandateHistory.source.scope.target,
  )
  // Attribution publishes on the PR while retaining the issue mandate as an
  // external history for canonical reference validation; it never copies it.
  return mandateIsPrimary || mandateIsParent ? input.evidence.parents : [mandateHistory, ...input.evidence.parents]
}

export async function startCiAttributionReceipt(
  input: ModelReceiptActionInput,
  context: ReceiptStartContext,
): Promise<ContinueFeatureResult> {
  if (input.target.status !== 'pull-request') return { kind: 'blocked', reason: 'ci-attribution-requires-pull-request' }
  const evidence = await readNativeCiFailureEvidence(
    input.cwd,
    input.scope.repository,
    input.target.pullRequest.head,
    input.scope,
    { gh: input.gh, failedCheckEvidenceDigest: input.loaded.failedCheckEvidenceDigest },
  )
  if (!evidence.ok) return { kind: 'blocked', reason: evidence.reason }
  const exactInputs = {
    candidateGitSHA: input.target.pullRequest.head,
    scope: input.scope,
    failedChecks: evidence.failedChecks,
    evidenceDigest: evidence.evidenceDigest,
    failures: evidence.failures,
  }
  const approved = approvedMandateContext(input.loaded, input.mandate, [
    context.mandateHistory,
    ...input.evidence.parents,
  ])
  // Absent Spec context may stay soft for legitimate no-pre-PR / standalone attribution.
  // Present-invalid / ambiguous Spec chain must refuse — never collapse to prose absence.
  if (approved.status === 'invalid') {
    return { kind: 'blocked', reason: `mandate-spec-${approved.reason}`, diagnostics: approved.diagnostics }
  }
  const base = await observeSha(input.git, input.cwd, input.target.pullRequest.base)
  const pinned = codePin(
    input.scope.repository,
    base ?? '',
    input.target.pullRequest.head,
    input.target.pullRequest.head,
  )
  if (!pinned.ok) return blocks(pinned.reason)
  if (input.uw === undefined) return blocks('prepare-action-unavailable')
  const prepared = await prepareDeliveryAction(
    input.uw,
    actionRequest({
      actionId: context.operationId,
      purpose: 'attribute-ci',
      subject: uwSubject(context.mandateScope, input.scope),
      code: pinned.code,
    }),
  )
  if (!prepared.ok) return blocks(prepareRefusal(prepared.diagnostics), prepared.diagnostics)
  return sealReceipt({
    loaded: input.loaded,
    history: input.history,
    scope: input.scope,
    cwd: input.cwd,
    gh: input.gh,
    parents: ciPublicationParents(input, context.mandateHistory),
    operationId: context.operationId,
    action: 'attribute-ci',
    mandate: { scope: context.mandateScope, recordId: input.mandate.recordId, kind: 'mandate' },
    exactInputs,
    prepared: prepared.value,
  })
}
