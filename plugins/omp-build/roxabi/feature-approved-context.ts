import type { Diagnostic } from '../engine/record-values.ts'
import type { PlanBlockerRef } from '../engine/workflow-output-schema.ts'
import type { ActionReceiptPayload, WorkflowReceiptAction } from '../engine/workflow-receipt-schema.ts'
import type { Contracts, History, HistoryRecord, Scope } from './feature-engine.ts'
import { additionalRequirementsOf } from './workflow-overrides.ts'

export type MandateRecord = Extract<HistoryRecord, { kind: 'mandate' }>
export type ActionStartReceipt<A extends WorkflowReceiptAction = WorkflowReceiptAction> = Omit<
  Extract<HistoryRecord, { kind: 'action-receipt' }>,
  'payload'
> & { payload: Extract<ActionReceiptPayload, { phase: 'start' }> & { action: A } }
type ActionReceiptResultRecord<A extends WorkflowReceiptAction> = Omit<
  Extract<HistoryRecord, { kind: 'action-receipt' }>,
  'payload'
> & { payload: Extract<ActionReceiptPayload, { phase: 'result' }> & { action: A } }

function isActionStartReceipt(record: HistoryRecord | null): record is ActionStartReceipt {
  return record?.kind === 'action-receipt' && record.payload.phase === 'start'
}

export type ApprovedMandateContext =
  | {
      mandate: MandateRecord
      status: 'ready'
      specBody: string
      specDigest: string
      specReference: string
      chain: readonly unknown[]
      sourceRefs: readonly unknown[]
      requirements: string[]
      requirementsBlock: string
      specBlock: string
    }
  | { status: 'absent' }
  | { status: 'invalid'; reason: string; diagnostics: readonly Diagnostic[] }

/** Approved Spec via resolveAcceptedSpec + effective requirements. Never local defaults or soft fallback. */
export function approvedMandateContext(
  contracts: Contracts,
  mandate: History['operations'][number]['record'] | null | undefined,
  histories: readonly History[],
): ApprovedMandateContext {
  if (mandate === null || mandate === undefined || mandate.kind !== 'mandate') return { status: 'absent' }
  const accepted = contracts.resolveAcceptedSpec(mandate, histories)
  if (!accepted.ok) {
    return {
      status: 'invalid',
      reason: accepted.reason,
      diagnostics: accepted.evidence ?? [{ code: accepted.reason, message: accepted.reason }],
    }
  }
  const config = mandate.payload.config
  const requirements = additionalRequirementsOf(config.effective)
  const requirementsBlock =
    requirements.length === 0
      ? 'Approved additionalRequirements: (none).'
      : `Approved additionalRequirements (mandate effective):\n${requirements.map((item, index) => `${index + 1}. ${item}`).join('\n')}`
  return {
    mandate,
    status: 'ready',
    specBody: accepted.spec.body,
    specDigest: accepted.spec.digest,
    specReference: accepted.spec.reference,
    chain: accepted.spec.chain,
    sourceRefs: accepted.spec.sourceRefs,
    requirements,
    requirementsBlock,
    specBlock: [
      `Accepted Spec reference=${accepted.spec.reference}`,
      `Accepted Spec digest=${accepted.spec.digest}`,
      `Accepted Spec sourceRefs=${JSON.stringify(accepted.spec.sourceRefs)}`,
      `Accepted Spec chain=${JSON.stringify(accepted.spec.chain)}`,
      'Accepted Spec body:',
      accepted.spec.body,
      requirementsBlock,
    ].join('\n'),
  }
}

export function startedActionReceipt(
  history: History,
  start: { recordId: string },
  operationId: string,
): ActionStartReceipt | null {
  for (const operation of history.operations) {
    const record = operation.record
    if (isActionStartReceipt(record) && record.recordId === start.recordId && record.payload.actionId === operationId) {
      return record
    }
  }
  return null
}

export function mandateReference(opened: ActionStartReceipt): { scope: Scope; recordId: string } | null {
  const mandate = opened.payload.mandate
  return mandate.kind === 'mandate' ? { scope: mandate.scope, recordId: mandate.recordId } : null
}

function hasRecordKind<K extends HistoryRecord['kind']>(
  record: HistoryRecord | null,
  kind: K,
): record is Extract<HistoryRecord, { kind: K }> {
  return record?.kind === kind
}

function isActionReceiptResult<A extends WorkflowReceiptAction>(
  record: HistoryRecord | null,
  action: A,
  actionId: string,
): record is ActionReceiptResultRecord<A> {
  return (
    record?.kind === 'action-receipt' &&
    record.payload.action === action &&
    record.payload.phase === 'result' &&
    record.payload.actionId === actionId
  )
}

export function findHistoryRecord<K extends HistoryRecord['kind']>(
  histories: readonly History[],
  kind: K,
  recordId: string,
): Extract<HistoryRecord, { kind: K }> | null {
  for (const history of histories) {
    for (const operation of history.operations) {
      const record = operation.record
      if (hasRecordKind(record, kind) && record.recordId === recordId) return record
    }
  }
  return null
}

/** Authoritative final plan id from the same planMacro that declared planning complete. */
export function finalEligiblePlanActionId(macro: {
  phase: string
  draftActionId: string | null
  amendmentActionId: string | null
}): string | null {
  if (macro.phase !== 'eligible') return null
  return macro.amendmentActionId ?? macro.draftActionId
}

export function actionReceiptResult<A extends WorkflowReceiptAction>(
  history: History,
  action: A,
  actionId: string | null,
): ActionReceiptResultRecord<A> | null {
  if (actionId === null) return null
  for (const operation of history.operations) {
    const record = operation.record
    if (isActionReceiptResult(record, action, actionId)) return record
  }
  return null
}

export function planStructuredBlock(history: History, planActionId: string | null, label: string): string | null {
  const record = actionReceiptResult(history, 'plan', planActionId)
  if (record === null || record.payload.structured === null) return null
  return `${label} actionId=${planActionId}:\n${JSON.stringify(record.payload.structured)}`
}

export function planReviewOriginalsBlock(history: History, reviewActionId: string | null): string | null {
  const record = actionReceiptResult(history, 'plan-review', reviewActionId)
  if (record === null) return null
  return [
    `Original plan-review actionId=${reviewActionId}`,
    `slots=${JSON.stringify(record.payload.slots)}`,
    `contributions=${JSON.stringify(record.payload.contributions)}`,
  ].join('\n')
}

/** planExactSchema refs only. Requirements stay on the mandate; prompts use approvedMandateContext. */
export function planExactInputs(input: {
  mandateId: string
  specDigest: string
  amendsReviewActionId: string | null
  requiredBlockers: PlanBlockerRef[]
}): {
  mandateId: string
  specDigest: string
  amendsReviewActionId: string | null
  requiredBlockers: PlanBlockerRef[]
} {
  return {
    mandateId: input.mandateId,
    specDigest: input.specDigest,
    amendsReviewActionId: input.amendsReviewActionId,
    requiredBlockers: input.requiredBlockers,
  }
}

/** planReviewExactSchema refs only. Requirements stay on the mandate; prompts use approvedMandateContext. */
export function planReviewExactInputs(input: {
  mandateId: string
  specDigest: string
  planDigest: string
  draftActionId: string
}): {
  mandateId: string
  specDigest: string
  planDigest: string
  draftActionId: string
} {
  return {
    mandateId: input.mandateId,
    specDigest: input.specDigest,
    planDigest: input.planDigest,
    draftActionId: input.draftActionId,
  }
}
