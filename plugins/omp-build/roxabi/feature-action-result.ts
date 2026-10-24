import { randomUUID } from 'node:crypto'
import { ciAttributionSchema, planOutputSchema, specAssessmentSchema } from '../dist/contracts.js'
import type { ScopedRecordRef } from '../engine/record-references.ts'
import type { ActionReceiptPayload, WorkflowReceiptAction } from '../engine/workflow-receipt-schema.ts'
import type { NativeBatchResult } from '../omp/review-runtime/contracts.ts'
import { type ActionStartReceipt, mandateReference, startedActionReceipt } from './feature-approved-context.ts'
import { explicitParentHistories } from './feature-context.ts'
import { type Contracts, defaultGh, type History, loadContracts, publishRecord } from './feature-engine.ts'
import { emptyChild, nativeOutcome } from './feature-native-outcome.ts'

type Gh = (cwd: string, args: string[]) => Promise<string>
type PlanReviewResultPayload = Extract<ActionReceiptPayload, { action: 'plan-review'; phase: 'result' }>
type ClassifiedResultPayload = Extract<
  ActionReceiptPayload,
  { action: 'assess-spec' | 'attribute-ci'; phase: 'result' }
>

type NonImplementPublication<A extends WorkflowReceiptAction = WorkflowReceiptAction> = {
  loaded: Contracts
  gh: Gh
  history: History
  receiptScope: ScopedRecordRef['scope']
  publicationParents: History[]
  opened: ActionStartReceipt<A>
  cwd: string
}

function isOpenedAction<A extends WorkflowReceiptAction>(
  context: NonImplementPublication,
  action: A,
): context is NonImplementPublication<A> {
  return context.opened.payload.action === action
}

async function publicationParents(
  loaded: Contracts,
  opened: ActionStartReceipt,
  receiptScope: ScopedRecordRef['scope'],
  parents: History[],
  cwd: string,
  gh: Gh,
): Promise<History[] | { reason: string }> {
  const mandate = mandateReference(opened)
  if (mandate === null) return { reason: 'action-uncertain' }
  const mandateRead = await loaded.readComposedWorkflowHistory([mandate.scope], { cwd, gh })
  if (!mandateRead.ok || !mandateRead.histories[0]) {
    return { reason: mandateRead.ok ? 'incomplete' : mandateRead.reason }
  }
  const mandateHistory = mandateRead.histories[0]
  const mandateRecord = mandateHistory.operations.find(
    (operation) =>
      operation.status === 'complete' &&
      operation.record?.kind === 'mandate' &&
      operation.record.recordId === mandate.recordId,
  )?.record
  if (mandateRecord == null) return { reason: 'action-uncertain' }
  const external = await explicitParentHistories(loaded, mandateRecord, { cwd, gh })
  if (!external.ok) return { reason: external.reason }
  for (const context of [mandateHistory, ...external.parents]) {
    if (
      context.source.scope.repository === receiptScope.repository &&
      context.source.scope.target === receiptScope.target
    )
      continue
    if (
      parents.some(
        (known) =>
          known.source.scope.repository === context.source.scope.repository &&
          known.source.scope.target === context.source.scope.target,
      )
    )
      continue
    parents.push(context)
  }
  return parents
}

async function resolvePublication(input: {
  cwd: string
  result: NativeBatchResult
  start: ScopedRecordRef
  gh?: Gh
}): Promise<NonImplementPublication | { reason: string }> {
  const loaded = await loadContracts()
  if ('missing' in loaded) return { reason: `engine-unavailable:${loaded.missing}` }
  const gh = input.gh ?? defaultGh()
  if (input.start.kind !== 'action-receipt') return { reason: 'action-uncertain' }
  const composed = await loaded.readComposedWorkflowHistory([input.start.scope], { cwd: input.cwd, gh })
  if (!composed.ok) return { reason: composed.reason }
  const history = composed.histories[0]
  if (!history) return { reason: 'incomplete' }
  const opened = startedActionReceipt(history, input.start, input.result.batch.operationId)
  if (opened === null) return { reason: 'action-uncertain' }
  const parents = await publicationParents(
    loaded,
    opened,
    input.start.scope,
    composed.histories.slice(1),
    input.cwd,
    gh,
  )
  if ('reason' in parents) return parents
  return { loaded, gh, history, receiptScope: input.start.scope, publicationParents: parents, opened, cwd: input.cwd }
}

async function publishPlanReviewResult(
  context: NonImplementPublication<'plan-review'>,
  result: NativeBatchResult,
): Promise<{ published: true } | { published: false; reason: string }> {
  const { slots } = context.opened.payload
  const contributions: PlanReviewResultPayload['contributions'] = slots.map((slot) => {
    const { slotId, specialist } = slot
    const child = result.children.find((entry) => entry.expectedId === slotId) ?? null
    return {
      content: 'action-result',
      inventoryId: null,
      host: { origin: 'native', phase: null, role: specialist, slotId, chunk: null, childId: child?.id ?? null },
      rawAttempts: child === null ? [] : child.submissions,
      native: child === null ? null : nativeOutcome(child, child.usable && child.structured !== null),
      structured: child?.structured ?? null,
      findings: null,
    }
  })
  const published = await publishRecord(
    context.loaded,
    context.history,
    {
      repository: context.receiptScope.repository,
      target: context.receiptScope.target,
      version: 1,
      recordId: randomUUID(),
      runId: randomUUID(),
      operationId: `${result.batch.operationId}:result`,
      kind: 'action-receipt',
      payload: {
        phase: 'result',
        action: 'plan-review',
        actionId: result.batch.operationId,
        mandate: context.opened.payload.mandate,
        start: { scope: context.receiptScope, recordId: context.opened.recordId, kind: 'action-receipt' },
        exactInputs: context.opened.payload.exactInputs,
        slots,
        contributions,
        native: nativeOutcome(result.children[0] ?? emptyChild(), true),
        structured: null,
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
  )
  return published.ok ? { published: true } : { published: false, reason: published.reason }
}

async function publishPlanResult(
  context: NonImplementPublication<'plan'>,
  result: NativeBatchResult,
  child: NativeBatchResult['children'][number],
): Promise<{ published: true } | { published: false; reason: string }> {
  const parsed = planOutputSchema.safeParse(child.structured)
  if (!parsed.success) return { published: false, reason: 'plan-output-invalid' }
  const structured = parsed.data
  const published = await publishRecord(
    context.loaded,
    context.history,
    {
      repository: context.receiptScope.repository,
      target: context.receiptScope.target,
      version: 1,
      recordId: randomUUID(),
      runId: randomUUID(),
      operationId: `${result.batch.operationId}:result`,
      kind: 'action-receipt',
      payload: {
        phase: 'result',
        action: 'plan',
        actionId: result.batch.operationId,
        mandate: context.opened.payload.mandate,
        start: { scope: context.receiptScope, recordId: context.opened.recordId, kind: 'action-receipt' },
        exactInputs: context.opened.payload.exactInputs,
        native: nativeOutcome(child, true),
        structured: { steps: structured.steps, resolutions: structured.resolutions },
        admission: null,
        diagnostics: [],
      },
    },
    context.gh,
    context.cwd,
    context.publicationParents,
  )
  return published.ok ? { published: true } : { published: false, reason: published.reason }
}

async function publishClassificationPayload(
  context: NonImplementPublication<'assess-spec'> | NonImplementPublication<'attribute-ci'>,
  result: NativeBatchResult,
  payload: ClassifiedResultPayload,
): Promise<{ published: true } | { published: false; reason: string }> {
  const published = await publishRecord(
    context.loaded,
    context.history,
    {
      repository: context.receiptScope.repository,
      target: context.receiptScope.target,
      version: 1,
      recordId: randomUUID(),
      runId: randomUUID(),
      operationId: `${result.batch.operationId}:result`,
      kind: 'action-receipt',
      payload,
    },
    context.gh,
    context.cwd,
    context.publicationParents,
  )
  return published.ok ? { published: true } : { published: false, reason: published.reason }
}

async function publishClassificationResult(
  context: NonImplementPublication<'assess-spec'> | NonImplementPublication<'attribute-ci'>,
  result: NativeBatchResult,
  child: NativeBatchResult['children'][number],
): Promise<{ published: true } | { published: false; reason: string }> {
  if (context.opened.payload.action === 'assess-spec') {
    const parsed = specAssessmentSchema.safeParse(child.structured)
    if (!parsed.success) return { published: false, reason: 'assess-spec-output-invalid' }
    return publishClassificationPayload(context, result, {
      phase: 'result',
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
  const parsed = ciAttributionSchema.safeParse(child.structured)
  if (!parsed.success) return { published: false, reason: 'attribute-ci-output-invalid' }
  return publishClassificationPayload(context, result, {
    phase: 'result',
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
}): Promise<{ published: true } | { published: false; reason: string }> {
  const context = await resolvePublication(input)
  if ('reason' in context) return { published: false, reason: context.reason }
  if (!input.result.complete) return { published: false, reason: 'action-uncertain' }
  if (isOpenedAction(context, 'plan-review')) return publishPlanReviewResult(context, input.result)
  const child = input.result.children[0]
  if (!child) return { published: false, reason: 'missing-contribution' }
  if (isOpenedAction(context, 'plan')) return publishPlanResult(context, input.result, child)
  if (isOpenedAction(context, 'assess-spec')) return publishClassificationResult(context, input.result, child)
  if (isOpenedAction(context, 'attribute-ci')) return publishClassificationResult(context, input.result, child)
  return { published: false, reason: `action-result-unhandled:${context.opened.payload.action}` }
}
