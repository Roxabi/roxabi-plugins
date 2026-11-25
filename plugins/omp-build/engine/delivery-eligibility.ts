import { nativeResultValid } from './delivery-observation-authentication.ts'
import { authenticateHistoricalReceiptStart } from './historical-receipt-pair.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, fail, sameRef } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Diagnostic } from './record-values.ts'
import type { Result } from './result.ts'
import { workflowContextNegative } from './workflow-context-output.ts'
import { recordsOf } from './workflow-control.ts'
import { planOutputSchema } from './workflow-output-schema.ts'
import type { ActionReceiptPayload } from './workflow-receipt-schema.ts'

export {
  citedOperationIntegrity,
  implementationReceiptEligible,
  integrationReceiptEligible,
  nativeResultValid,
  observationAuthenticationDiagnostics,
  observationRefDiagnostics,
} from './delivery-observation-authentication.ts'

type Receipt = Extract<CanonicalRecord, { kind: 'action-receipt' }>
type PlanResult = Extract<ActionReceiptPayload, { action: 'plan'; phase: 'result' }>

export function uniqueAccounted<T>(items: readonly T[], label: string): Result<T | null> {
  if (items.length === 0) return { ok: true, value: null }
  if (items.length > 1) return fail([diagnostic('ambiguous', `${label} has unordered applicability`)])
  return { ok: true, value: items[0] ?? null }
}

export function planReceiptEligible(record: Receipt): boolean {
  return (
    record.payload.format === 'omp-build-action-receipt/2' &&
    record.payload.action === 'plan' &&
    nativeResultValid(record) &&
    record.payload.phase === 'result' &&
    planOutputSchema.safeParse(record.payload.structured).success
  )
}

export function planReviewReceiptEligible(record: Receipt): boolean {
  return record.payload.action === 'plan-review' && nativeResultValid(record) && !workflowContextNegative(record)
}

type PlanCandidate = {
  record: Receipt
  payload: PlanResult
  history: DecodedHistory
}

function currentPlanCandidate(
  record: CanonicalRecord,
  specDigest: string,
  mandate: ExternalRecordRef,
  history: DecodedHistory,
): PlanCandidate[] {
  if (record.kind !== 'action-receipt' || !planReceiptEligible(record)) return []
  if (record.payload.action !== 'plan' || record.payload.phase !== 'result') return []
  if (!sameRef(record.payload.mandate, mandate)) return []
  if (!('amendsReviewActionId' in record.payload.exactInputs) || !('specDigest' in record.payload.exactInputs))
    return []
  if (record.payload.exactInputs.specDigest !== specDigest) return []
  return [{ record, payload: record.payload, history }]
}

function uniquePairedPlan(
  candidates: readonly PlanCandidate[],
  label: string,
  histories: readonly DecodedHistory[],
  diagnostics: Diagnostic[],
): Result<PlanCandidate | null> {
  const paired = candidates.filter(({ history, record }) => {
    const start = authenticateHistoricalReceiptStart(history, record, histories)
    if (!start.ok) diagnostics.push(...start.diagnostics)
    return start.ok
  })
  return uniqueAccounted(paired, label)
}

export function currentPlanReceipt(
  histories: readonly DecodedHistory[],
  specDigest: string,
  mandate: ExternalRecordRef,
  diagnostics: Diagnostic[],
): Result<Receipt | null> {
  const plans = histories.flatMap((history) =>
    recordsOf(history).flatMap((record) => currentPlanCandidate(record, specDigest, mandate, history)),
  )
  const drafts = uniquePairedPlan(
    plans.filter((row) => row.payload.exactInputs.amendsReviewActionId === null),
    'current plan draft',
    histories,
    diagnostics,
  )
  if (!drafts.ok) return drafts
  if (drafts.value === null) return { ok: true, value: null }
  const draft = drafts.value
  const amendments = plans.filter(
    (row) =>
      row.payload.exactInputs.amendsReviewActionId !== null &&
      histories.some((history) =>
        recordsOf(history).some((review) => {
          if (
            review.kind !== 'action-receipt' ||
            review.payload.action !== 'plan-review' ||
            review.payload.phase !== 'result' ||
            !planReviewReceiptEligible(review) ||
            !sameRef(review.payload.mandate, mandate) ||
            review.payload.exactInputs.specDigest !== specDigest ||
            review.payload.actionId !== row.payload.exactInputs.amendsReviewActionId ||
            review.payload.exactInputs.draftActionId !== draft.payload.actionId
          )
            return false
          const start = authenticateHistoricalReceiptStart(history, review, histories)
          if (!start.ok) diagnostics.push(...start.diagnostics)
          return start.ok
        }),
      ),
  )
  const selected = uniquePairedPlan(amendments, 'current plan amendment', histories, diagnostics)
  if (!selected.ok) return selected
  return { ok: true, value: selected.value?.record ?? draft.record }
}
