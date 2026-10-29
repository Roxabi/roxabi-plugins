import { randomUUID } from 'node:crypto'
import { canonicalValueDigest } from '../dist/contracts.js'
import type { RecordInputRef } from '../engine/action-input-schema.ts'
import type { PlanMacro } from '../engine/workflow-plan.ts'
import {
  actionRequest,
  blocks,
  confirmStartReadback,
  deliveryBatch,
  deliveryTask,
  observeHeadCode,
  prepareDeliveryAction,
  prepareRefusal,
  uwSubject,
} from './delivery-action.ts'
import {
  type ApprovedMandateContext,
  actionReceiptResult,
  approvedMandateContext,
  type MandateRecord,
  planExactInputs,
} from './feature-approved-context.ts'
import type { ContinueFeatureResult } from './feature-contract.ts'
import { type Contracts, type History, publishRecord, type Scope, type WorkflowEvidence } from './feature-engine.ts'
import { startPlanReview } from './feature-plan-review-start.ts'
import { knownRoleSelector } from './uw-action-selection.ts'
import type { UwOperations } from './uw-contract.ts'
import type { GitRunner } from './workflow-checkout.ts'

type Gh = (cwd: string, args: string[]) => Promise<string>

type ReadyMandateContext = Extract<ApprovedMandateContext, { status: 'ready' }>
type AmendmentPlanMacro = PlanMacro & {
  phase: 'needs-amendment'
  draftActionId: string
  reviewActionId: string
}

function isAmendmentPlanMacro(macro: PlanMacro): macro is AmendmentPlanMacro {
  return macro.phase === 'needs-amendment' && macro.draftActionId !== null && macro.reviewActionId !== null
}

function stageRef(
  record: { repository: string; target: string; recordId: string },
  selector: string,
  value: unknown,
): RecordInputRef | null {
  if (!knownRoleSelector('action-receipt', selector)) return null
  return {
    source: 'record',
    record: {
      scope: { repository: record.repository, target: record.target },
      recordId: record.recordId,
      kind: 'action-receipt',
    },
    selector,
    digest: canonicalValueDigest(value),
  }
}

async function startPlanAmendment(
  contracts: Contracts,
  evidence: WorkflowEvidence,
  history: History,
  gh: Gh,
  cwd: string,
  scope: Scope,
  mandate: MandateRecord,
  approved: ReadyMandateContext,
  macro: AmendmentPlanMacro,
  uw: UwOperations | undefined,
  git: GitRunner,
): Promise<ContinueFeatureResult> {
  if (uw === undefined) return blocks('prepare-action-unavailable')
  const draft = actionReceiptResult(history, 'plan', macro.draftActionId)
  if (draft?.payload.structured == null) return { kind: 'blocked', reason: 'plan-draft-unreadable' }
  const review = actionReceiptResult(history, 'plan-review', macro.reviewActionId)
  if (review === null) return { kind: 'blocked', reason: 'plan-review-unbound' }
  const stageSources = [
    stageRef(draft, '/payload/structured', draft.payload.structured),
    stageRef(review, '/payload/slots', review.payload.slots),
    stageRef(review, '/payload/contributions', review.payload.contributions),
  ].filter((ref): ref is RecordInputRef => ref !== null)
  if (stageSources.length !== 3) return blocks('prepare-action-unavailable')
  const operationId = randomUUID()
  const startId = randomUUID()
  const code = await observeHeadCode(git, cwd, scope.repository)
  if (!code.ok) return blocks(code.reason)
  const prepared = await prepareDeliveryAction(
    uw,
    actionRequest({
      actionId: operationId,
      purpose: 'plan',
      subject: uwSubject(scope, null),
      code: code.code,
      stageSources,
    }),
  )
  if (!prepared.ok) return blocks(prepareRefusal(prepared.diagnostics), prepared.diagnostics)
  const started = await publishRecord(
    contracts,
    history,
    {
      repository: scope.repository,
      target: scope.target,
      version: 1,
      recordId: startId,
      runId: randomUUID(),
      operationId,
      kind: 'action-receipt',
      payload: {
        phase: 'start',
        action: 'plan',
        actionId: operationId,
        mandate: { scope, recordId: mandate.recordId, kind: 'mandate' },
        exactInputs: planExactInputs({
          mandateId: mandate.recordId,
          specDigest: approved.accepted.ref.version,
          amendsReviewActionId: macro.reviewActionId,
          requiredBlockers: macro.blockers,
        }),
        format: 'omp-build-action-receipt/2',
        inputs: prepared.value.inputs,
      },
    },
    gh,
    cwd,
    evidence.parents,
  )
  if (!started.ok) return { kind: 'blocked', reason: started.reason, diagnostics: started.diagnostics }
  const confirmed = await confirmStartReadback({
    read: (scopes) => contracts.readComposedWorkflowHistory(scopes, { cwd, gh }),
    scope,
    recordId: startId,
    inputs: prepared.value.inputs,
  })
  if (!confirmed.ok) return blocks(confirmed.reason)
  return {
    kind: 'action',
    node: 'plan',
    start: { scope, recordId: startId, kind: 'action-receipt' },
    followUp: deliveryBatch(operationId, [
      deliveryTask({
        name: 'R-workflow-plan',
        agent: 'R-workflow-plan',
        procedure:
          'Amend the plan named by the index so every required blocker is resolved. Keep original review labels. Use criterionIds. Do not implement.',
        solutionSpace: 'one plan amendment',
        prepared: prepared.value,
      }),
    ]),
  }
}

async function startPlanDraft(
  contracts: Contracts,
  evidence: WorkflowEvidence,
  history: History,
  gh: Gh,
  cwd: string,
  scope: Scope,
  mandate: MandateRecord,
  approved: ReadyMandateContext,
  uw: UwOperations | undefined,
  git: GitRunner,
): Promise<ContinueFeatureResult> {
  if (uw === undefined) return blocks('prepare-action-unavailable')
  if (approved.accepted.snapshot.spec.criteria.length === 0) return { kind: 'operator-decision', reason: 'needs-scope' }
  const operationId = randomUUID()
  const startId = randomUUID()
  const code = await observeHeadCode(git, cwd, scope.repository)
  if (!code.ok) return blocks(code.reason)
  const prepared = await prepareDeliveryAction(
    uw,
    actionRequest({ actionId: operationId, purpose: 'plan', subject: uwSubject(scope, null), code: code.code }),
  )
  if (!prepared.ok) return blocks(prepareRefusal(prepared.diagnostics), prepared.diagnostics)
  const started = await publishRecord(
    contracts,
    history,
    {
      repository: scope.repository,
      target: scope.target,
      version: 1,
      recordId: startId,
      runId: randomUUID(),
      operationId,
      kind: 'action-receipt',
      payload: {
        phase: 'start',
        action: 'plan',
        actionId: operationId,
        mandate: { scope, recordId: mandate.recordId, kind: 'mandate' },
        exactInputs: planExactInputs({
          mandateId: mandate.recordId,
          specDigest: approved.accepted.ref.version,
          amendsReviewActionId: null,
          requiredBlockers: [],
        }),
        format: 'omp-build-action-receipt/2',
        inputs: prepared.value.inputs,
      },
    },
    gh,
    cwd,
    evidence.parents,
  )
  if (!started.ok) return { kind: 'blocked', reason: started.reason, diagnostics: started.diagnostics }
  const confirmed = await confirmStartReadback({
    read: (scopes) => contracts.readComposedWorkflowHistory(scopes, { cwd, gh }),
    scope,
    recordId: startId,
    inputs: prepared.value.inputs,
  })
  if (!confirmed.ok) return blocks(confirmed.reason)
  return {
    kind: 'action',
    node: 'plan',
    start: { scope, recordId: startId, kind: 'action-receipt' },
    followUp: deliveryBatch(operationId, [
      deliveryTask({
        name: 'R-workflow-plan',
        agent: 'R-workflow-plan',
        procedure:
          'Map every accepted criterion id to the code it changes and the evidence that proves it. Use criterionIds. Do not implement.',
        solutionSpace: 'one plan draft',
        prepared: prepared.value,
      }),
    ]),
  }
}

export async function planAction(
  contracts: Contracts,
  evidence: WorkflowEvidence,
  history: History,
  gh: Gh,
  cwd: string,
  scope: Scope,
  mandate: NonNullable<History['operations'][number]['record']>,
  uw: UwOperations | undefined,
  git: GitRunner,
): Promise<ContinueFeatureResult> {
  const approved = approvedMandateContext(contracts, mandate, [history, ...evidence.parents])
  if (approved.status === 'invalid') {
    return { kind: 'blocked', reason: `mandate-spec-${approved.reason}`, diagnostics: approved.diagnostics }
  }
  if (approved.status !== 'ready') return { kind: 'blocked', reason: 'mandate-spec-missing' }
  // Plan/implement consume the accepted Spec snapshot, not a live reread.
  const macro = contracts.planMacro(evidence, approved.mandate)
  if (macro.phase === 'uncertain' || macro.phase === 'blocked') {
    return { kind: 'blocked', reason: macro.evidence[0]?.code ?? macro.phase, diagnostics: macro.evidence }
  }
  if (macro.phase === 'needs-review') {
    return startPlanReview(
      contracts,
      evidence,
      history,
      gh,
      cwd,
      scope,
      approved.mandate,
      approved,
      macro.draftActionId,
      uw,
      git,
    )
  }
  if (isAmendmentPlanMacro(macro)) {
    return startPlanAmendment(contracts, evidence, history, gh, cwd, scope, approved.mandate, approved, macro, uw, git)
  }
  if (macro.phase !== 'needs-draft') return { kind: 'blocked', reason: `plan-phase-${macro.phase}` }
  return startPlanDraft(contracts, evidence, history, gh, cwd, scope, approved.mandate, approved, uw, git)
}
