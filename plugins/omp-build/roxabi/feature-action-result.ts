import { randomUUID } from 'node:crypto'
import { ciAttributionSchema, planOutputSchema, specAssessmentSchema } from '../dist/contracts.js'
import { missingContextOutputSchema } from '../engine/action-context.ts'
import type { ScopedRecordRef } from '../engine/record-references.ts'
import type { ActionReceiptPayload, WorkflowReceiptAction } from '../engine/workflow-receipt-schema.ts'
import type { NativeBatchResult } from '../omp/review-runtime/contracts.ts'
import { type NonImplementPublication, resolvePublication } from './feature-action-publication-context.ts'
import { matchesContextNegative, matchesPlanReviewNegative } from './feature-context-negative.ts'
import { publishRecord } from './feature-engine.ts'
import { emptyChild, nativeOutcome } from './feature-native-outcome.ts'

type Gh = (cwd: string, args: string[]) => Promise<string>
type PlanReviewResultPayload = Extract<ActionReceiptPayload, { action: 'plan-review'; phase: 'result' }>
type ClassifiedResultPayload = Extract<
  ActionReceiptPayload,
  { action: 'assess-spec' | 'attribute-ci'; phase: 'result' }
>

function isOpenedAction<A extends WorkflowReceiptAction>(
  context: NonImplementPublication,
  action: A,
): context is NonImplementPublication<A> {
  return context.opened.payload.action === action
}

async function publishPlanReviewResult(
  context: NonImplementPublication<'plan-review'>,
  result: NativeBatchResult,
): Promise<{ published: true; recordId: string } | { published: false; reason: string }> {
  const negativeChild = result.children.find((child) => child.contextBlock !== undefined)
  const negative = negativeChild === undefined ? null : missingContextOutputSchema.safeParse(negativeChild.structured)
  if (negative !== null && !negative.success) return { published: false, reason: 'plan-review-output-invalid' }
  const { slots } = context.opened.payload
  const contributions: PlanReviewResultPayload['contributions'] = slots.flatMap(({ slotId, specialist }) => {
    const child = result.children.find((entry) => entry.expectedId === slotId) ?? null
    if (negative !== null && (child === null || child.id === null)) return []
    return [
      {
        content: 'action-result' as const,
        inventoryId: null,
        host: {
          origin: 'native' as const,
          phase: null,
          role: specialist,
          slotId,
          chunk: null,
          childId: child?.id ?? null,
          ...(child?.contextBlock === undefined ? {} : { action: child.contextBlock.action }),
        },
        rawAttempts: child === null ? [] : child.submissions,
        native: child === null ? null : nativeOutcome(child, child.usable && child.structured !== null),
        structured: child?.structured ?? null,
        findings: null,
      },
    ]
  })
  const recordId = randomUUID(),
    published = await publishRecord(
      context.loaded,
      context.history,
      {
        repository: context.receiptScope.repository,
        target: context.receiptScope.target,
        version: 1,
        recordId,
        runId: randomUUID(),
        operationId: `${result.batch.operationId}:result`,
        kind: 'action-receipt',
        payload: {
          format: 'omp-build-action-receipt/2',
          phase: 'result',
          inputs: context.opened.payload.inputs,
          action: 'plan-review',
          actionId: result.batch.operationId,
          mandate: context.opened.payload.mandate,
          start: { scope: context.receiptScope, recordId: context.opened.recordId, kind: 'action-receipt' },
          exactInputs: context.opened.payload.exactInputs,
          slots,
          contributions,
          native: nativeOutcome(negativeChild ?? result.children[0] ?? emptyChild(), true),
          structured: negative?.success ? negative.data : null,
          admission: null,
          diagnostics: contributions
            .filter((contribution) => contribution.host.childId === null)
            .map((contribution) => ({
              code: 'missing-contribution',
              message: `plan-review slot ${contribution.host.slotId ?? 'unknown'} missing`,
            })),
        },
      },
      context.gh,
      context.cwd,
      context.publicationParents,
      result.canPublishContext,
    )
  return published.ok ? { published: true, recordId } : { published: false, reason: published.reason }
}

async function publishPlanResult(
  context: NonImplementPublication<'plan'>,
  result: NativeBatchResult,
  child: NativeBatchResult['children'][number],
): Promise<{ published: true; recordId: string } | { published: false; reason: string }> {
  const parsed = (child.contextBlock === undefined ? planOutputSchema : missingContextOutputSchema).safeParse(
    child.structured,
  )
  if (!parsed.success) return { published: false, reason: 'plan-output-invalid' }
  const structured = parsed.data
  const recordId = randomUUID(),
    published = await publishRecord(
      context.loaded,
      context.history,
      {
        repository: context.receiptScope.repository,
        target: context.receiptScope.target,
        version: 1,
        recordId,
        runId: randomUUID(),
        operationId: `${result.batch.operationId}:result`,
        kind: 'action-receipt',
        payload: {
          format: 'omp-build-action-receipt/2',
          phase: 'result',
          inputs: context.opened.payload.inputs,
          action: 'plan',
          actionId: result.batch.operationId,
          mandate: context.opened.payload.mandate,
          start: { scope: context.receiptScope, recordId: context.opened.recordId, kind: 'action-receipt' },
          exactInputs: context.opened.payload.exactInputs,
          native: nativeOutcome(child, true),
          structured,
          admission: null,
          diagnostics: [],
        },
      },
      context.gh,
      context.cwd,
      context.publicationParents,
      result.canPublishContext,
    )
  return published.ok ? { published: true, recordId } : { published: false, reason: published.reason }
}

async function publishClassificationPayload(
  context: NonImplementPublication<'assess-spec'> | NonImplementPublication<'attribute-ci'>,
  result: NativeBatchResult,
  payload: ClassifiedResultPayload,
): Promise<{ published: true; recordId: string } | { published: false; reason: string }> {
  const recordId = randomUUID(),
    published = await publishRecord(
      context.loaded,
      context.history,
      {
        repository: context.receiptScope.repository,
        target: context.receiptScope.target,
        version: 1,
        recordId,
        runId: randomUUID(),
        operationId: `${result.batch.operationId}:result`,
        kind: 'action-receipt',
        payload,
      },
      context.gh,
      context.cwd,
      context.publicationParents,
      result.canPublishContext,
    )
  return published.ok ? { published: true, recordId } : { published: false, reason: published.reason }
}

async function publishClassificationResult(
  context: NonImplementPublication<'assess-spec'> | NonImplementPublication<'attribute-ci'>,
  result: NativeBatchResult,
  child: NativeBatchResult['children'][number],
): Promise<{ published: true; recordId: string } | { published: false; reason: string }> {
  if (context.opened.payload.action === 'assess-spec') {
    const parsed = (child.contextBlock === undefined ? specAssessmentSchema : missingContextOutputSchema).safeParse(
      child.structured,
    )
    if (!parsed.success) return { published: false, reason: 'assess-spec-output-invalid' }
    return publishClassificationPayload(context, result, {
      format: 'omp-build-action-receipt/2',
      phase: 'result',
      inputs: context.opened.payload.inputs,
      action: 'assess-spec',
      actionId: result.batch.operationId,
      mandate: context.opened.payload.mandate,
      start: { scope: context.receiptScope, recordId: context.opened.recordId, kind: 'action-receipt' },
      exactInputs: context.opened.payload.exactInputs,
      native: nativeOutcome(child, true),
      structured: parsed.data,
      admission: null,
      diagnostics: [],
    })
  }
  const parsed = (child.contextBlock === undefined ? ciAttributionSchema : missingContextOutputSchema).safeParse(
    child.structured,
  )
  if (!parsed.success) return { published: false, reason: 'attribute-ci-output-invalid' }
  return publishClassificationPayload(context, result, {
    format: 'omp-build-action-receipt/2',
    phase: 'result',
    inputs: context.opened.payload.inputs,
    action: 'attribute-ci',
    actionId: result.batch.operationId,
    mandate: context.opened.payload.mandate,
    start: { scope: context.receiptScope, recordId: context.opened.recordId, kind: 'action-receipt' },
    exactInputs: context.opened.payload.exactInputs,
    native: nativeOutcome(child, true),
    structured: parsed.data,
    admission: null,
    diagnostics: [],
  })
}

export async function publishNonImplementResult(input: {
  cwd: string
  result: NativeBatchResult
  start: ScopedRecordRef
  gh?: Gh
}): Promise<{ published: true; recordId: string } | { published: false; reason: string }> {
  const context = await resolvePublication(input)
  if ('reason' in context) return { published: false, reason: context.reason }
  if (
    input.result.children.some((child) => child.contextBlock !== undefined) &&
    input.result.canPublishContext?.() !== true
  )
    return { published: false, reason: 'publication-ownership-revoked' }
  if (!input.result.complete && !input.result.children.some((child) => child.contextBlock !== undefined))
    return { published: false, reason: 'action-uncertain' }
  if (
    input.result.children.some(
      (child) =>
        child.contextBlock !== undefined &&
        !(isOpenedAction(context, 'plan-review')
          ? matchesPlanReviewNegative(child, context.opened.payload.slots)
          : matchesContextNegative(child, context.opened.payload.actionId, context.opened.payload.inputs)),
    )
  )
    return { published: false, reason: 'action-context-binding-mismatch' }
  if (isOpenedAction(context, 'plan-review')) return publishPlanReviewResult(context, input.result)
  const child = input.result.children[0]
  if (!child) return { published: false, reason: 'missing-contribution' }
  if (isOpenedAction(context, 'plan')) return publishPlanResult(context, input.result, child)
  if (isOpenedAction(context, 'assess-spec')) return publishClassificationResult(context, input.result, child)
  if (isOpenedAction(context, 'attribute-ci')) return publishClassificationResult(context, input.result, child)
  return { published: false, reason: `action-result-unhandled:${context.opened.payload.action}` }
}
