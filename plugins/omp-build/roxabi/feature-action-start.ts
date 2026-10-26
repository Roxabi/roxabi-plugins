import { randomUUID } from 'node:crypto'
import type { Scope } from '../engine/record-values.ts'
import { modelAction } from './feature-action-prompts.ts'
import { approvedMandateContext, finalEligiblePlanActionId, planStructuredBlock } from './feature-approved-context.ts'
import { readNativeCiFailureEvidence } from './feature-ci-evidence.ts'
import type { ContinueFeatureResult } from './feature-contract.ts'
import { type Contracts, type History, publishRecord, type WorkflowEvidence } from './feature-engine.ts'
import type { GitRunner } from './workflow-checkout.ts'
import { acceptanceCriteria } from './workflow-overrides.ts'

type Gh = (cwd: string, args: string[]) => Promise<string>

type ModelReceiptActionInput = {
  action: 'assess-spec' | 'attribute-ci'
  loaded: Contracts
  history: History
  mandateHistory?: History
  mandate: NonNullable<History['operations'][number]['record']>
  evidence: WorkflowEvidence
  scope: Scope
  issue: { body: string }
  target:
    | { status: 'issue'; scope: Scope; issue: { number: number } }
    | { status: 'pull-request'; scope: Scope; pullRequest: { pr: number; head: string; base: string; branch: string } }
  gh: Gh
  cwd: string
}

type ReceiptStartContext = {
  mandateHistory: History
  mandateScope: Scope
  operationId: string
}

function receiptStartContext(input: ModelReceiptActionInput): ReceiptStartContext {
  return {
    mandateHistory: input.mandateHistory ?? input.history,
    mandateScope: { repository: input.mandate.repository, target: input.mandate.target },
    operationId: randomUUID(),
  }
}

async function publishAssessmentReceipt(
  input: ModelReceiptActionInput,
  context: ReceiptStartContext,
  exactInputs: { acceptedBody: string; acceptedDigest: string; currentBody: string; currentDigest: string },
): Promise<ContinueFeatureResult> {
  const startId = randomUUID()
  const started = await publishRecord(
    input.loaded,
    input.history,
    {
      repository: input.scope.repository,
      target: input.scope.target,
      version: 1,
      recordId: startId,
      runId: randomUUID(),
      operationId: context.operationId,
      kind: 'action-receipt',
      payload: {
        phase: 'start',
        action: 'assess-spec',
        actionId: context.operationId,
        mandate: { scope: context.mandateScope, recordId: input.mandate.recordId, kind: 'mandate' },
        exactInputs,
      },
    },
    input.gh,
    input.cwd,
    input.evidence.parents,
  )
  if (!started.ok) return { kind: 'blocked', reason: started.reason, diagnostics: started.diagnostics }
  return modelAction({
    action: 'assess-spec',
    scope: input.scope,
    start: { scope: input.scope, recordId: startId, kind: 'action-receipt' },
    operationId: context.operationId,
    assessPair: exactInputs,
  })
}

async function startAssessmentReceipt(
  input: ModelReceiptActionInput,
  context: ReceiptStartContext,
): Promise<ContinueFeatureResult> {
  if (input.mandate.kind !== 'mandate') return { kind: 'blocked', reason: 'mandate-spec-missing' }
  const accepted = input.loaded.resolveAcceptedSpec(input.mandate, [context.mandateHistory, ...input.evidence.parents])
  if (!accepted.ok) return { kind: 'blocked', reason: 'mandate-spec-missing' }
  return publishAssessmentReceipt(input, context, {
    acceptedDigest: accepted.spec.digest,
    currentDigest: input.loaded.specDigest(input.issue.body),
    acceptedBody: accepted.spec.body,
    currentBody: input.issue.body,
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

async function startCiAttributionReceipt(
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
  const acceptedSemanticContext =
    approved.status === 'absent'
      ? 'Accepted semantic context: (absent — no confirmed accepted Spec for this attribution; do not invent a pre-PR plan or Spec).'
      : approved.specBlock
  const startId = randomUUID()
  const started = await publishRecord(
    input.loaded,
    input.history,
    {
      repository: input.scope.repository,
      target: input.scope.target,
      version: 1,
      recordId: startId,
      runId: randomUUID(),
      operationId: context.operationId,
      kind: 'action-receipt',
      payload: {
        phase: 'start',
        action: 'attribute-ci',
        actionId: context.operationId,
        mandate: { scope: context.mandateScope, recordId: input.mandate.recordId, kind: 'mandate' },
        exactInputs,
      },
    },
    input.gh,
    input.cwd,
    ciPublicationParents(input, context.mandateHistory),
  )
  if (!started.ok) return { kind: 'blocked', reason: started.reason, diagnostics: started.diagnostics }
  return modelAction({
    action: 'attribute-ci',
    scope: input.scope,
    start: { scope: input.scope, recordId: startId, kind: 'action-receipt' },
    operationId: context.operationId,
    ciEvidence: {
      evidenceDigest: evidence.evidenceDigest,
      failures: evidence.failures,
      supplied: evidence.supplied,
      candidateGitSHA: input.target.pullRequest.head,
      scope: input.scope,
      acceptedSemanticContext,
    },
  })
}

export async function startModelReceiptAction(input: ModelReceiptActionInput): Promise<ContinueFeatureResult> {
  const context = receiptStartContext(input)
  return input.action === 'assess-spec'
    ? startAssessmentReceipt(input, context)
    : startCiAttributionReceipt(input, context)
}

export async function startImplement(
  loaded: Contracts,
  evidence: WorkflowEvidence,
  history: History,
  scope: Scope,
  issue: { body: string },
  git: GitRunner,
  gh: Gh,
  cwd: string,
  mandate: NonNullable<History['operations'][number]['record']>,
): Promise<ContinueFeatureResult> {
  void git
  void issue
  const composed = evidence.parents
  const approved = approvedMandateContext(loaded, mandate, [history, ...composed])
  if (approved.status === 'invalid') {
    return { kind: 'blocked', reason: `mandate-spec-${approved.reason}`, diagnostics: approved.diagnostics }
  }
  if (approved.status !== 'ready') return { kind: 'blocked', reason: 'mandate-spec-missing' }
  const macro = loaded.planMacro(evidence, approved.mandate)
  const planAction = finalEligiblePlanActionId(macro)
  if (planAction === null) return { kind: 'blocked', reason: 'plan-unconfirmed' }
  const planBlock = planStructuredBlock(history, planAction, 'Confirmed final plan')
  if (planBlock === null) return { kind: 'blocked', reason: 'plan-unconfirmed' }
  const operationId = randomUUID()
  const recordId = randomUUID()
  const published = await publishRecord(
    loaded,
    history,
    {
      repository: scope.repository,
      target: scope.target,
      version: 1,
      recordId,
      runId: randomUUID(),
      operationId,
      kind: 'action-receipt',
      payload: {
        phase: 'start',
        action: 'implement',
        actionId: operationId,
        mandate: { scope, recordId: approved.mandate.recordId, kind: 'mandate' },
        // implementExactSchema refs only; prompt embeds accepted Spec + final plan selected by planMacro.
        exactInputs: {
          mandateId: approved.mandate.recordId,
          planActionId: planAction,
        },
      },
    },
    gh,
    cwd,
    composed,
  )
  if (!published.ok) return { kind: 'blocked', reason: published.reason, diagnostics: published.diagnostics }
  const reread = await loaded.readComposedWorkflowHistory([scope], { cwd, gh })
  const seen = reread.ok && reread.histories[0]?.operations.some((operation) => operation.record?.recordId === recordId)
  if (!seen) return { kind: 'blocked', reason: 'implementation-start-unconfirmed' }
  const criteria = acceptanceCriteria(approved.specBody)
  return modelAction({
    action: 'implement',
    scope,
    start: { scope, recordId, kind: 'action-receipt' },
    operationId,
    approved: { ...approved, acceptanceLine: `Acceptance criteria: ${criteria.join(' | ')}` },
    planBlock,
  })
}
