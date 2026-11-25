import { canonicalValueDigest } from './action-input.ts'
import { nativeResultValid } from './delivery-observation-authentication.ts'
import { authenticatedReceiptActionInputs, authenticateHistoricalActionInputs } from './historical-action-inputs.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope, fail, sameRef } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Diagnostic } from './record-values.ts'
import type { Result } from './result.ts'
import { bindExternalRef, recordsOf } from './workflow-control.ts'
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
type HistoricalDeliveryResult = Extract<ActionReceiptPayload, { action: 'plan' | 'implement'; phase: 'result' }>

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

export function integrationStartPaired(history: DecodedHistory, result: Receipt): boolean {
  if (result.payload.action !== 'integrate' || result.payload.phase !== 'result') return false
  const payload = result.payload
  const bound = bindExternalRef(payload.start, history)
  if (!bound.ok) return false
  const record = bound.value
  return (
    record.kind === 'action-receipt' &&
    record.payload.action === 'integrate' &&
    record.payload.phase === 'start' &&
    record.recordId === payload.start.recordId &&
    record.repository === payload.start.scope.repository &&
    record.target === payload.start.scope.target &&
    record.payload.actionId === payload.actionId &&
    sameRef(record.payload.mandate, payload.mandate) &&
    canonicalValueDigest(record.payload.inputs) === canonicalValueDigest(payload.inputs) &&
    canonicalValueDigest(record.payload.exactInputs) === canonicalValueDigest(payload.exactInputs)
  )
}

function hasCompetingHistoricalStart(history: DecodedHistory, result: HistoricalDeliveryResult): boolean {
  return recordsOf(history).some(
    (record) =>
      record.kind === 'action-receipt' &&
      record.recordId !== result.start.recordId &&
      record.payload.phase === 'start' &&
      record.payload.action === result.action &&
      record.payload.actionId === result.actionId &&
      sameRef(record.payload.mandate, result.mandate) &&
      bindExternalRef({ ...result.start, recordId: record.recordId }, history).ok,
  )
}

function historicalStartPair(
  history: DecodedHistory,
  result: HistoricalDeliveryResult,
  histories: readonly DecodedHistory[],
): Result<void> {
  const unpaired = (message: string, diagnostics: Diagnostic[] = []): Result<never> =>
    fail([
      diagnostic(
        result.action === 'plan' ? 'plan-start-unpaired' : 'implementation-start-unpaired',
        `${result.action} ${result.actionId}: ${message}`,
        { start: result.start, resultScope: history.source.scope },
      ),
      ...diagnostics,
    ])
  if (result.start.kind !== 'action-receipt' || !equalScope(result.start.scope, history.source.scope))
    return unpaired('START must be an action receipt in the RESULT history')
  const bound = bindExternalRef(result.start, history)
  if (!bound.ok) return unpaired('Cited START cannot be authenticated', bound.diagnostics)
  const start = bound.value
  if (
    start.kind !== 'action-receipt' ||
    start.recordId !== result.start.recordId ||
    start.repository !== result.start.scope.repository ||
    start.target !== result.start.scope.target ||
    start.payload.phase !== 'start' ||
    start.payload.action !== result.action ||
    start.payload.actionId !== result.actionId ||
    !sameRef(start.payload.mandate, result.mandate) ||
    canonicalValueDigest(start.payload.exactInputs) !== canonicalValueDigest(result.exactInputs) ||
    canonicalValueDigest(start.payload.inputs) !== canonicalValueDigest(result.inputs)
  )
    return unpaired('Cited START does not match the RESULT action, mandate, exact inputs, and manifest capture')
  if (hasCompetingHistoricalStart(history, result))
    return unpaired('More than one authenticated START identifies this action invocation')
  const authenticated = authenticateHistoricalActionInputs(start.payload.inputs, histories)
  return authenticated.ok
    ? { ok: true, value: undefined }
    : unpaired('START inputs are not authenticated', authenticated.diagnostics)
}

type PlanCandidate = {
  record: Receipt
  payload: Extract<HistoricalDeliveryResult, { action: 'plan' }>
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
  const paired = candidates.filter(({ history, payload }) => {
    const start = historicalStartPair(history, payload, histories)
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
            review.payload.phase !== 'result'
          )
            return false
          if (!sameRef(review.payload.mandate, mandate)) return false
          if (!('draftActionId' in review.payload.exactInputs)) return false
          return (
            review.payload.actionId === row.payload.exactInputs.amendsReviewActionId &&
            review.payload.exactInputs.draftActionId === draft.payload.actionId &&
            authenticatedReceiptActionInputs(review.payload, histories)
          )
        }),
      ),
  )
  const selected = uniquePairedPlan(amendments, 'current plan amendment', histories, diagnostics)
  if (!selected.ok) return selected
  return { ok: true, value: selected.value?.record ?? draft.record }
}

export function implementationStartPaired(
  history: DecodedHistory,
  result: Receipt,
  histories: readonly DecodedHistory[] = [history],
): Result<void> {
  if (result.payload.action !== 'implement' || result.payload.phase !== 'result')
    return fail([diagnostic('unconfirmed', 'Expected an implementation RESULT')])
  return historicalStartPair(history, result.payload, histories)
}
