import { randomUUID } from 'node:crypto'
import { planOutputSchema } from '../dist/contracts.js'
import type { PlanReviewSlot } from '../engine/workflow-receipt-schema.ts'
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
  type MandateRecord,
  planReviewExactInputs,
} from './feature-approved-context.ts'
import type { ContinueFeatureResult } from './feature-contract.ts'
import { type Contracts, type History, publishRecord, type Scope, type WorkflowEvidence } from './feature-engine.ts'
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
): Promise<ContinueFeatureResult> {
  if (draftActionId === null) return { kind: 'blocked', reason: 'plan-review-unbound' }
  if (uw === undefined) return blocks('prepare-action-unavailable')
  const draft = actionReceiptResult(history, 'plan', draftActionId)
  const structured = planOutputSchema.safeParse(draft?.payload.structured)
  if (!structured.success) return { kind: 'blocked', reason: 'plan-draft-unreadable' }
  const planDigest = contracts.planDigest(structured.data)
  const operationId = randomUUID()
  const startId = randomUUID()
  const code = await observeHeadCode(git, cwd, scope.repository)
  if (!code.ok) return blocks(code.reason)
  const architectId = randomUUID()
  const adversarialId = randomUUID()
  const subject = uwSubject(scope, null)
  const architect = await prepareDeliveryAction(
    uw,
    actionRequest({ actionId: architectId, purpose: 'plan-review', subject, code: code.code }),
  )
  const adversarial = await prepareDeliveryAction(
    uw,
    actionRequest({ actionId: adversarialId, purpose: 'plan-review', subject, code: code.code }),
  )
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
