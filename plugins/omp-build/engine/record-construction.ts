import { diagnostic, equalScope, fail } from './record-diagnostics.ts'
import { recordFormatDiagnostic } from './record-format.ts'
import { type CanonicalRecord, recordSchema } from './record-schema.ts'
import type { Result } from './result.ts'
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

function derivedInputs(draft: RecordDraft): string[] {
  switch (draft.kind) {
    case 'review-attempt':
      if (draft.payload.stage !== 'initial') return [draft.payload.rootAttemptId]
      return draft.payload.purpose === 'correction' ? [draft.payload.requestId] : []
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
      return [draft.payload.decisionId]
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
      ]
    case 'stop':
      return [draft.payload.reviewId]
    case 'epic-event':
      return []
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
