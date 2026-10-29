import { diagnostic, equalScope, fail } from './record-diagnostics.ts'
import { recordFormatDiagnostic } from './record-format.ts'
import { type CanonicalRecord, recordSchema } from './record-schema.ts'
import type { Result } from './result.ts'
import { isInitialPullRequestReviewInventory } from './review-schema.ts'
import { scopedRefsOf, workflowInputMeaning } from './workflow-record-references.ts'

export function parseRecord(value: unknown): Result<CanonicalRecord> {
  const format = recordFormatDiagnostic(value)
  if (format) return fail([format])
  const parsed = recordSchema.safeParse(value)
  if (!parsed.success)
    return fail([
      diagnostic(
        'malformed',
        'Record does not match the canonical schema',
        parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      ),
    ])
  const meaning = workflowInputMeaning(parsed.data)
  return meaning === null ? { ok: true, value: parsed.data } : fail([meaning])
}
export type RecordDraft = {
  [K in CanonicalRecord['kind']]: Omit<Extract<CanonicalRecord, { kind: K }>, 'inputs'>
}[CanonicalRecord['kind']]

function reviewAttemptInputs(draft: Extract<RecordDraft, { kind: 'review-attempt' }>): string[] {
  if (draft.payload.stage !== 'initial') return [draft.payload.rootAttemptId]
  if (draft.payload.purpose === 'correction') return [draft.payload.requestId]
  if (isInitialPullRequestReviewInventory(draft.payload) && draft.payload.replacement !== undefined)
    return [
      draft.payload.replacement.rootAttemptId,
      draft.payload.replacement.dispositionId,
      draft.payload.replacement.grantId,
    ]
  return []
}

function derivedInputs(draft: RecordDraft): string[] {
  switch (draft.kind) {
    case 'review-attempt':
      return reviewAttemptInputs(draft)
    case 'contribution':
      return draft.payload.inventoryId === null ? [] : [draft.payload.inventoryId]
    case 'decision':
      return [draft.payload.originalContributionId, ...draft.payload.judgment.sourceContributionIds]
    case 'review':
      return [draft.payload.decisionId, ...draft.payload.inventoryIds]
    case 'fix-request':
      return draft.payload.existingReviewId === null
        ? [draft.payload.requestContributionId]
        : [draft.payload.requestContributionId, draft.payload.existingReviewId]
    case 'correction-result':
      return [
        draft.payload.decisionId,
        ...(draft.payload.appliedContributionId == null ? [] : [draft.payload.appliedContributionId]),
        ...(draft.payload.criterionObservations ?? []).map((item) => item.sourceContributionId),
      ]
    case 'falsification-result':
      return [draft.payload.correctionResultId]
    case 'debt-receipt':
      return [draft.payload.decisionId]
    case 'fix-result':
      return [
        draft.payload.requestId,
        draft.payload.decisionId,
        ...draft.payload.correctionResultIds,
        ...draft.payload.falsificationResultIds,
        ...draft.payload.debtReceiptIds,
        ...(draft.payload.criterionReceipt === undefined ? [] : [draft.payload.criterionReceipt.sourceContributionId]),
      ]
    case 'stop':
      return [draft.payload.reviewId]
    case 'epic-event':
      return []
    case 'review-interruption':
      return [
        draft.payload.rootAttemptId,
        ...scopedRefsOf(draft)
          .filter((ref) => equalScope(ref.scope, { repository: draft.repository, target: draft.target }))
          .map((ref) => ref.recordId),
      ]
    case 'review-replacement-grant':
      return [
        draft.payload.rootAttemptId,
        draft.payload.dispositionId,
        ...scopedRefsOf(draft)
          .filter((ref) => equalScope(ref.scope, { repository: draft.repository, target: draft.target }))
          .map((ref) => ref.recordId),
      ]
    case 'spec-identity':
    case 'mandate':
    case 'operator-control':
    case 'action-receipt':
    case 'workflow-binding':
      return scopedRefsOf(draft)
        .filter((ref) => equalScope(ref.scope, { repository: draft.repository, target: draft.target }))
        .map((ref) => ref.recordId)
  }
}
export function buildRecord<K extends CanonicalRecord['kind']>(
  draft: Extract<RecordDraft, { kind: K }>,
  contextInputs?: readonly string[],
): Result<Extract<CanonicalRecord, { kind: K }>>
export function buildRecord(draft: RecordDraft, contextInputs: readonly string[] = []): Result<CanonicalRecord> {
  return parseRecord({ ...draft, inputs: [...new Set([...derivedInputs(draft), ...contextInputs])] })
}
