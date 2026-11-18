import { randomUUID } from 'node:crypto'
import { canonicalValueDigest, planOutputSchema } from '../dist/contracts.js'
import type { PlanReviewSlot } from '../engine/workflow-receipt-schema.ts'
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
  planReviewExactInputs,
} from './feature-approved-context.ts'
import type { ContinueFeatureResult } from './feature-contract.ts'
import { type Contracts, type History, publishRecord, type Scope, type WorkflowEvidence } from './feature-engine.ts'
import type { PreparedUwAction, UwActionRequest } from './uw-action-contract.ts'
import type { UwOperations } from './uw-contract.ts'
import type { GitRunner } from './workflow-checkout.ts'

type Gh = (cwd: string, args: string[]) => Promise<string>
type ReadyMandateContext = Extract<ApprovedMandateContext, { status: 'ready' }>

export async function startPlanReview(
  contracts: Contracts,
  evidence: WorkflowEvidence,
  history: History,
  gh: Gh,
  cwd: string,
  scope: Scope,
  mandate: MandateRecord,
  approved: ReadyMandateContext,
  draftActionId: string | null,
  uw: UwOperations | undefined,
  git: GitRunner,
  recovery?: { request: UwActionRequest; prepared: PreparedUwAction; slotId: string },
): Promise<ContinueFeatureResult> {
  if (draftActionId === null) return { kind: 'blocked', reason: 'plan-review-unbound' }
  if (uw === undefined) return blocks('prepare-action-unavailable')
  const draft = actionReceiptResult(history, 'plan', draftActionId)
  const structured = planOutputSchema.safeParse(draft?.payload.structured)
  if (!structured.success) return { kind: 'blocked', reason: 'plan-draft-unreadable' }
  const planDigest = contracts.planDigest(structured.data)
  const operationId = randomUUID()
  const startId = randomUUID()
  const code = await observeCleanHeadCode(git, cwd, scope.repository)
  if (!code.ok) return blocks(code.reason)
  if (recovery !== undefined && recovery.slotId !== 'architect' && recovery.slotId !== 'adversarial')
    return blocks('context-recovery-input-changed')
  const architectId = recovery?.slotId === 'architect' ? recovery.request.actionId : randomUUID()
  const adversarialId = recovery?.slotId === 'adversarial' ? recovery.request.actionId : randomUUID()
  const subject = uwSubject(scope, null)
  const prepareSlot = async (slotId: string, actionId: string) => {
    const selected = recovery?.slotId === slotId ? recovery : undefined
    const request = actionRequest({
      actionId,
      purpose: 'plan-review',
      subject,
      code: code.code,
      expandedContext: recovery?.request.expandedContext,
    })
    if (selected === undefined) return prepareDeliveryAction(uw, request)
    if (
      canonicalValueDigest(request) !== canonicalValueDigest(selected.request) ||
      !(await uw.verifyAction(selected.prepared.snapshot)).ok
    )
      return null
    return { ok: true as const, value: selected.prepared }
  }
  const architect = await prepareSlot('architect', architectId)
  const adversarial = await prepareSlot('adversarial', adversarialId)
  if (architect === null || adversarial === null) return blocks('context-recovery-input-changed')
  if (!architect.ok) return blocks(prepareRefusal(architect.diagnostics), architect.diagnostics)
  if (!adversarial.ok) return blocks(prepareRefusal(adversarial.diagnostics), adversarial.diagnostics)
  const slots: PlanReviewSlot[] = [
    {
      slotId: 'architect',
      specialist: 'R-workflow-plan-architect',
      action: { actionId: architect.value.snapshot.actionId, inputs: architect.value.inputs },
    },
    {
      slotId: 'adversarial',
      specialist: 'R-workflow-plan-adversarial',
      action: { actionId: adversarial.value.snapshot.actionId, inputs: adversarial.value.inputs },
    },
  ]
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
        action: 'plan-review',
        actionId: operationId,
        mandate: { scope, recordId: mandate.recordId, kind: 'mandate' },
        exactInputs: planReviewExactInputs({
          mandateId: mandate.recordId,
          draftActionId,
          specDigest: approved.accepted.ref.version,
          planDigest,
        }),
        slots,
        format: 'omp-build-action-receipt/2',
        inputs: architect.value.inputs,
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
    inputs: architect.value.inputs,
  })
  if (!confirmed.ok) return blocks(confirmed.reason)
  const procedure =
    'Review the confirmed plan named by the index. Return clear, or one blocker naming criterionId. Do not implement.'
  return {
    kind: 'action',
    node: 'plan-review',
    start: { scope, recordId: startId, kind: 'action-receipt' },
    followUp: deliveryBatch(operationId, [
      deliveryTask({
        name: 'architect',
        agent: 'R-workflow-plan-architect',
        procedure,
        solutionSpace: 'one plan-review judgment',
        prepared: architect.value,
      }),
      deliveryTask({
        name: 'adversarial',
        agent: 'R-workflow-plan-adversarial',
        procedure,
        solutionSpace: 'one plan-review judgment',
        prepared: adversarial.value,
      }),
    ]),
  }
}
