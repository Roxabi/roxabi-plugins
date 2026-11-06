import { randomUUID } from 'node:crypto'
import { canonicalValueDigest } from '../dist/contracts.js'
import type { Scope } from '../engine/record-values.ts'
import type { AcceptedOwnSpec } from '../engine/workflow-accepted-spec-types.ts'
import {
  actionRequest,
  blocks,
  confirmPreparedAction,
  observeHeadCode,
  observeSha,
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
import type { RecordInputRef } from './uw-action-contract.ts'
import { integrationProofInputs } from './uw-action-stage-closure.ts'
import type { UwOperations } from './uw-contract.ts'
import type { GitRunner } from './workflow-checkout.ts'

export async function startModelReceiptAction(input: ModelReceiptActionInput): Promise<ContinueFeatureResult> {
  const context = receiptStartContext(input)
  return input.action === 'assess-spec'
    ? startAssessmentReceipt(input, context)
    : startCiAttributionReceipt(input, context)
}

async function integrationSources(
  uw: UwOperations,
  scope: Scope,
  accepted: AcceptedOwnSpec,
): Promise<{ sources: readonly RecordInputRef[] } | ContinueFeatureResult> {
  const read = await uw.readUw(scope)
  if (
    read.observation.status !== 'complete' ||
    read.accepted.status !== 'accepted' ||
    canonicalValueDigest(read.accepted.value) !== canonicalValueDigest(accepted)
  )
    return blocks('integration-observation-incomplete')
  const projected = integrationProofInputs(read)
  if (!projected.ok) return blocks(prepareRefusal(projected.diagnostics), projected.diagnostics)
  return { sources: projected.value.stageSources }
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
  const approved = approvedMandateContext(loaded, mandate, evidence.causal?.histories ?? [history, ...composed])
  if (approved.status === 'invalid') {
    return { kind: 'blocked', reason: `mandate-spec-${approved.reason}`, diagnostics: approved.diagnostics }
  }
  if (approved.status !== 'ready') return { kind: 'blocked', reason: 'mandate-spec-missing' }
  const macro = loaded.planMacro(evidence, approved.mandate)
  const planAction = finalEligiblePlanActionId(macro)
  if (planAction === null) return { kind: 'blocked', reason: 'plan-unconfirmed' }
  const action = approved.accepted.children.length > 0 ? 'integrate' : 'implement'
  const operationId = randomUUID()
  const code = await observeHeadCode(git, cwd, scope.repository)
  if (!code.ok) return blocks(code.reason)
  if (uw === undefined) return blocks('prepare-action-unavailable')
  const stageSources: RecordInputRef[] = []
  if (action === 'integrate') {
    const base = await observeSha(git, cwd, `origin/${approved.mandate.payload.base}`)
    if (base === null) return blocks('integration-base-unobserved')
    code.code.base = base
    const projected = await integrationSources(uw, scope, approved.accepted)
    if ('kind' in projected) return projected
    stageSources.push(...projected.sources)
  }
  const prepared = await (action === 'integrate' ? confirmPreparedAction : prepareDeliveryAction)(
    uw,
    actionRequest({
      actionId: operationId,
      purpose: action,
      subject: uwSubject(scope, null),
      code: code.code,
      ...(action === 'integrate'
        ? {
            operands: {
              action: 'integrate' as const,
              exactInputs: { mandateId: approved.mandate.recordId, planActionId: planAction },
            },
          }
        : {}),
      stageSources,
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
    action,
    mandate: { scope, recordId: approved.mandate.recordId, kind: 'mandate' },
    exactInputs: { mandateId: approved.mandate.recordId, planActionId: planAction },
    prepared: prepared.value,
  })
}
