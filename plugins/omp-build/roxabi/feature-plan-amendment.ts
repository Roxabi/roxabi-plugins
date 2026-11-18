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
  observeCleanHeadCode,
  prepareDeliveryAction,
  prepareRefusal,
  uwSubject,
} from './delivery-action.ts'
import {
  type ApprovedMandateContext,
  actionReceiptResult,
  type MandateRecord,
  planExactInputs,
} from './feature-approved-context.ts'
import type { ContinueFeatureResult } from './feature-contract.ts'
import { type Contracts, type History, publishRecord, type Scope, type WorkflowEvidence } from './feature-engine.ts'
import type { PreparedUwAction, UwActionRequest } from './uw-action-contract.ts'
import { knownRoleSelector } from './uw-action-selection.ts'
import type { UwOperations } from './uw-contract.ts'
import type { GitRunner } from './workflow-checkout.ts'

type Gh = (cwd: string, args: string[]) => Promise<string>
type ReadyMandateContext = Extract<ApprovedMandateContext, { status: 'ready' }>
type PlannerRecovery = { request: UwActionRequest; prepared: PreparedUwAction }
export type AmendmentPlanMacro = PlanMacro & { phase: 'needs-amendment'; draftActionId: string; reviewActionId: string }
function reviewRef(
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

export async function startPlanAmendment(
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
  recovery?: PlannerRecovery,
): Promise<ContinueFeatureResult> {
  if (uw === undefined) return blocks('prepare-action-unavailable')
  const draft = actionReceiptResult(history, 'plan', macro.draftActionId)
  if (draft?.payload.structured == null) return { kind: 'blocked', reason: 'plan-draft-unreadable' }
  const review = actionReceiptResult(history, 'plan-review', macro.reviewActionId)
  if (review === null) return { kind: 'blocked', reason: 'plan-review-unbound' }
  const reviewRefs = [
    reviewRef(review, '/payload/slots', review.payload.slots),
    reviewRef(review, '/payload/contributions', review.payload.contributions),
  ].filter((ref): ref is RecordInputRef => ref !== null)
  if (reviewRefs.length !== 2) return blocks('prepare-action-unavailable')
  const operationId = recovery?.request.actionId ?? randomUUID()
  const startId = randomUUID()
  const code = await observeCleanHeadCode(git, cwd, scope.repository)
  if (!code.ok) return blocks(code.reason)
  const request = actionRequest({
    actionId: operationId,
    purpose: 'plan',
    subject: uwSubject(scope, null),
    code: code.code,
    stageSources: [],
    expandedContext: recovery?.request.expandedContext ?? reviewRefs,
  })
  const prepared =
    recovery === undefined
      ? await prepareDeliveryAction(uw, request)
      : canonicalValueDigest(request) !== canonicalValueDigest(recovery.request) ||
          !(await uw.verifyAction(recovery.prepared.snapshot)).ok
        ? null
        : { ok: true as const, value: recovery.prepared }
  if (prepared === null) return blocks('context-recovery-input-changed')
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
