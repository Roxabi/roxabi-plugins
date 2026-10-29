import { nativeResultValid } from './delivery-observation-authentication.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, fail, sameRef } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Result } from './result.ts'
import { recordsOf } from './workflow-control.ts'
import { planOutputSchema } from './workflow-output-schema.ts'

export {
  citedOperationIntegrity,
  implementationReceiptEligible,
  nativeResultValid,
  observationAuthenticationDiagnostics,
  observationRefDiagnostics,
} from './delivery-observation-authentication.ts'

type Receipt = Extract<CanonicalRecord, { kind: 'action-receipt' }>

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

function currentPlanCandidate(record: CanonicalRecord, specDigest: string, mandate: ExternalRecordRef) {
  if (record.kind !== 'action-receipt' || !planReceiptEligible(record)) return []
  if (record.payload.action !== 'plan' || record.payload.phase !== 'result') return []
  if (!sameRef(record.payload.mandate, mandate)) return []
  if (!('amendsReviewActionId' in record.payload.exactInputs) || !('specDigest' in record.payload.exactInputs))
    return []
  if (record.payload.exactInputs.specDigest !== specDigest) return []
  return [{ record, exact: record.payload.exactInputs }]
}

export function currentPlanReceipt(
  histories: readonly DecodedHistory[],
  specDigest: string,
  mandate: ExternalRecordRef,
): Result<Receipt | null> {
  const plans = histories.flatMap((history) =>
    recordsOf(history).flatMap((record) => currentPlanCandidate(record, specDigest, mandate)),
  )
  const drafts = uniqueAccounted(
    plans.filter((row) => row.exact.amendsReviewActionId === null),
    'current plan draft',
  )
  if (!drafts.ok) return drafts
  if (drafts.value === null) return { ok: true, value: null }
  const draft = drafts.value
  const amendments = plans.filter(
    (row) =>
      row.exact.amendsReviewActionId !== null &&
      histories.some((history) =>
        recordsOf(history).some((review) => {
          if (
            review.kind !== 'action-receipt' ||
            review.payload.action !== 'plan-review' ||
            review.payload.phase !== 'result'
          )
            return false
          if (!sameRef(review.payload.mandate, mandate)) return false
          if (!('draftActionId' in review.payload.exactInputs)) return false
          return (
            review.payload.actionId === row.exact.amendsReviewActionId &&
            review.payload.exactInputs.draftActionId === draft.record.payload.actionId
          )
        }),
      ),
  )
  const selected = uniqueAccounted(amendments, 'current plan amendment')
  if (!selected.ok) return selected
  return { ok: true, value: selected.value?.record ?? draft.record }
}

export function implementationStartPaired(history: DecodedHistory, result: Receipt): boolean {
  if (result.payload.action !== 'implement' || result.payload.phase !== 'result') return false
  if (!('mandateId' in result.payload.exactInputs) || !('planActionId' in result.payload.exactInputs)) return false
  const resultExact = result.payload.exactInputs
  return recordsOf(history).some((record) => {
    if (record.kind !== 'action-receipt' || record.payload.action !== 'implement' || record.payload.phase !== 'start')
      return false
    if (!('mandateId' in record.payload.exactInputs) || !('planActionId' in record.payload.exactInputs)) return false
    return (
      record.payload.actionId === result.payload.actionId &&
      record.payload.exactInputs.mandateId === resultExact.mandateId &&
      record.payload.exactInputs.planActionId === resultExact.planActionId
    )
  })
}
