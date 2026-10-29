import { randomUUID } from 'node:crypto'
import type { Scope } from '../engine/record-values.ts'
import {
  actionRequest,
  blocks,
  observeHeadCode,
  prepareDeliveryAction,
  prepareRefusal,
  uwSubject,
} from './delivery-action.ts'
import {
  type Gh,
  type ModelReceiptActionInput,
  receiptStartContext,
  sealReceipt,
  startAssessmentReceipt,
  startCiAttributionReceipt,
} from './feature-action-receipt.ts'
import { approvedMandateContext, finalEligiblePlanActionId } from './feature-approved-context.ts'
import type { ContinueFeatureResult } from './feature-contract.ts'
import type { Contracts, History, WorkflowEvidence } from './feature-engine.ts'
import type { UwOperations } from './uw-contract.ts'
import type { GitRunner } from './workflow-checkout.ts'

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
  uw: UwOperations | undefined,
): Promise<ContinueFeatureResult> {
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
  const operationId = randomUUID()
  const code = await observeHeadCode(git, cwd, scope.repository)
  if (!code.ok) return blocks(code.reason)
  if (uw === undefined) return blocks('prepare-action-unavailable')
  const prepared = await prepareDeliveryAction(
    uw,
    actionRequest({
      actionId: operationId,
      purpose: 'implement',
      subject: uwSubject(scope, null),
      code: code.code,
    }),
  )
  if (!prepared.ok) return blocks(prepareRefusal(prepared.diagnostics), prepared.diagnostics)
  return sealReceipt({
    loaded,
    history,
    scope,
    cwd,
    gh,
    parents: composed,
    operationId,
    action: 'implement',
    mandate: { scope, recordId: approved.mandate.recordId, kind: 'mandate' },
    exactInputs: { mandateId: approved.mandate.recordId, planActionId: planAction },
    prepared: prepared.value,
  })
}
