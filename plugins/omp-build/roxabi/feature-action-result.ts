import { randomUUID } from 'node:crypto'
import {
  ciAttributionSchema,
  missingContextOutputSchema,
  planOutputSchema,
  specAssessmentSchema,
} from '../dist/contracts.js'
import type { ScopedRecordRef } from '../engine/record-references.ts'
import type { ActionReceiptPayload, WorkflowReceiptAction } from '../engine/workflow-receipt-schema.ts'
import type { NativeBatchResult, NativeStop } from '../omp/review-runtime/contracts.ts'
import { type NonImplementPublication, resolvePublication } from './feature-action-publication-context.ts'
import { publishInterruptedResult, publishTerminalNegative } from './feature-action-terminal-result.ts'
import { matchesContextNegative, matchesPlanReviewNegative } from './feature-context-negative.ts'
import { publishRecord } from './feature-engine.ts'
import { nativeOutcome } from './feature-native-outcome.ts'
import { publishPlanReviewResult } from './feature-plan-review-result.ts'

type Gh = (cwd: string, args: string[]) => Promise<string>
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

async function publishPlanResult(
  context: NonImplementPublication<'plan'>,
  result: NativeBatchResult,
  child: NativeBatchResult['children'][number],
): Promise<{ published: true; recordId: string } | { published: false; reason: string }> {
  const parsed = (child.contextBlock === undefined ? planOutputSchema : missingContextOutputSchema).safeParse(
    child.structured,
  )
  if (!parsed.success)
    return child.contextBlock === undefined
      ? publishTerminalNegative(context, result, 'plan-output-invalid', 'invalid')
      : { published: false, reason: 'plan-output-invalid' }
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
    if (!parsed.success)
      return child.contextBlock === undefined
        ? publishTerminalNegative(context, result, 'assess-spec-output-invalid', 'invalid')
        : { published: false, reason: 'assess-spec-output-invalid' }
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
  if (!parsed.success)
    return child.contextBlock === undefined
      ? publishTerminalNegative(context, result, 'attribute-ci-output-invalid', 'invalid')
      : { published: false, reason: 'attribute-ci-output-invalid' }
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

function invalidContextBinding(context: NonImplementPublication, result: NativeBatchResult): boolean {
  return result.children.some(
    (child) =>
      child.contextBlock !== undefined &&
      !(isOpenedAction(context, 'plan-review')
        ? matchesPlanReviewNegative(child, context.opened.payload.slots)
        : matchesContextNegative(child, context.opened.payload.actionId, context.opened.payload.inputs)),
  )
}

function unconfirmedAssessment(result: NativeBatchResult): boolean {
  const child = result.children[0]
  return (
    result.children.length !== 1 ||
    result.batch.tasks.tasks.length !== 1 ||
    child?.id === null ||
    child?.expectedId !== result.batch.tasks.tasks[0]?.name ||
    (!child?.usable && child?.contextBlock === undefined)
  )
}

function terminalFailure(result: NativeBatchResult, stop: NativeStop | undefined, action: WorkflowReceiptAction) {
  if (result.children.some((child) => child.contextBlock !== undefined)) return null
  if (stop?.kind === 'invalid-terminal') return { reason: `${action}-output-invalid`, strict: 'invalid' as const }
  if (stop?.kind === 'withheld')
    return {
      reason: 'action-uncertain',
      strict: result.children[0]?.usable ? ('valid' as const) : ('invalid' as const),
    }
  return null
}

function publishSelectedAction(context: NonImplementPublication, result: NativeBatchResult) {
  if (isOpenedAction(context, 'plan-review')) return publishPlanReviewResult(context, result)
  if (isOpenedAction(context, 'assess-spec') && unconfirmedAssessment(result))
    return Promise.resolve({ published: false as const, reason: 'assess-spec-native-child-unconfirmed' })
  const child = result.children[0]
  if (!child) return Promise.resolve({ published: false as const, reason: 'missing-contribution' })
  if (isOpenedAction(context, 'plan')) return publishPlanResult(context, result, child)
  if (isOpenedAction(context, 'assess-spec')) return publishClassificationResult(context, result, child)
  if (isOpenedAction(context, 'attribute-ci')) return publishClassificationResult(context, result, child)
  return Promise.resolve({
    published: false as const,
    reason: `action-result-unhandled:${context.opened.payload.action}`,
  })
}

export async function publishNonImplementResult(input: {
  cwd: string
  result: NativeBatchResult
  start: ScopedRecordRef
  stop?: NativeStop
  gh?: Gh
}): Promise<{ published: true; recordId: string } | { published: false; reason: string }> {
  const context = await resolvePublication(input)
  if ('reason' in context) return { published: false, reason: context.reason }
  if (
    input.result.children.some((child) => child.contextBlock !== undefined) &&
    input.result.canPublishContext?.() !== true
  )
    return { published: false, reason: 'publication-ownership-revoked' }
  if (input.stop?.kind === 'interrupted') return publishInterruptedResult(context, input.result, input.stop)
  const failure = terminalFailure(input.result, input.stop, context.opened.payload.action)
  if (failure !== null) return publishTerminalNegative(context, input.result, failure.reason, failure.strict)
  if (
    !input.result.complete &&
    input.stop?.kind !== 'completed-after-stop' &&
    !input.result.children.some((child) => child.contextBlock !== undefined)
  )
    return { published: false, reason: 'action-uncertain' }
  if (invalidContextBinding(context, input.result))
    return { published: false, reason: 'action-context-binding-mismatch' }
  const finalContext = await resolvePublication(input)
  if ('reason' in finalContext) return { published: false, reason: finalContext.reason }
  return publishSelectedAction(finalContext, input.result)
}
