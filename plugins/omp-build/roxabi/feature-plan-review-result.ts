import { randomUUID } from 'node:crypto'
import { canonicalValueDigest, missingContextOutputSchema } from '../dist/contracts.js'
import type { ActionReceiptPayload } from '../engine/workflow-receipt-schema.ts'
import type { NativeBatchResult } from '../omp/review-runtime/contracts.ts'
import type { NonImplementPublication } from './feature-action-publication-context.ts'
import { publishRecord } from './feature-engine.ts'
import { emptyChild, nativeOutcome } from './feature-native-outcome.ts'

type PlanReviewResultPayload = Extract<ActionReceiptPayload, { action: 'plan-review'; phase: 'result' }>

export async function publishPlanReviewResult(
  context: NonImplementPublication<'plan-review'>,
  result: NativeBatchResult,
): Promise<{ published: true; recordId: string } | { published: false; reason: string }> {
  const negativeChild = result.children.find((child) => child.contextBlock !== undefined)
  const negative = negativeChild === undefined ? null : missingContextOutputSchema.safeParse(negativeChild.structured)
  if (negative !== null && !negative.success) return { published: false, reason: 'plan-review-output-invalid' }
  if (negativeChild?.id === null) return { published: false, reason: 'plan-review-slot-action-unbound' }
  const { slots } = context.opened.payload
  for (const slot of slots) {
    const task = result.batch.tasks.tasks.find((entry) => entry.name === slot.slotId)
    const children = result.children.filter((entry) => entry.expectedId === slot.slotId)
    const child = children[0]
    if (
      slot.action === undefined ||
      task?.agent !== slot.specialist ||
      task.action === undefined ||
      task.action.snapshot.actionId !== slot.action.actionId ||
      canonicalValueDigest(task.action.inputs) !== canonicalValueDigest(slot.action.inputs) ||
      children.length > 1 ||
      (negative === null && child !== undefined && child.id === null) ||
      (child?.contextBlock !== undefined &&
        canonicalValueDigest(child.contextBlock.action) !== canonicalValueDigest(slot.action))
    )
      return { published: false, reason: 'plan-review-slot-action-unbound' }
  }
  const contributions: PlanReviewResultPayload['contributions'] = slots.flatMap(({ slotId, specialist, action }) => {
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
          ...(child === null ? {} : { action }),
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
