import { canonicalValueDigest } from './action-input.ts'
import type { ActionInputs } from './action-input-schema.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, sameRef } from './record-diagnostics.ts'
import type { Result } from './result.ts'
import { resolveAcceptedSpec } from './workflow-accepted-spec.ts'
import type { AcceptedOwnSpec } from './workflow-accepted-spec-types.ts'
import { authenticateCapturedWorkFrame } from './workflow-captured-frame.ts'
import { inspectPlanSpecialists } from './workflow-captured-plan-specialists.ts'
import type { ContextDisposition } from './workflow-context-disposition-schema.ts'
import { type InspectedContextNegative, inspectContextNegativeReceipt } from './workflow-context-negative-inspection.ts'
import {
  createHistoricalAcceptedSpecContext,
  type HistoricalAcceptedSpecContext,
  historicalAcceptedSpecFrame,
} from './workflow-context-succession-inspection.ts'
import { authenticateWorkflowReceiptPair } from './workflow-context-terminal.ts'
import { historyFor, type MandateRecord, type ReceiptRecord, recordsOf } from './workflow-control.ts'
import type { AcceptedSpecInspection } from './workflow-spec-authentication.ts'

export type QualifiedContextNegative = Omit<InspectedContextNegative, 'inspection'> &
  Readonly<{
    inspection: AcceptedSpecInspection
    histories: readonly DecodedHistory[]
    historical: HistoricalAcceptedSpecContext
    capturedPrefix: AcceptedOwnSpec
    accepted: AcceptedOwnSpec
    baselineCode: ActionInputs['manifest']['code']
  }>

/** Inspect retained authority without conferring current or delivery authority. */
export function qualifyContextNegative(
  input: Readonly<{
    mandate: MandateRecord
    histories: readonly DecodedHistory[]
    negative?: ContextDisposition['negative']
    historical?: HistoricalAcceptedSpecContext
  }>,
): Result<QualifiedContextNegative> {
  const inspected = inspectContextNegativeReceipt(input)
  if (!inspected.ok) return inspected
  const { negativeLeaf, negativeChain } = inspected.value
  const context =
    input.historical === undefined
      ? createHistoricalAcceptedSpecContext(input.histories)
      : { ok: true as const, value: input.historical }
  if (!context.ok) return context
  const frame = historicalAcceptedSpecFrame(context.value, input.histories, input.mandate, inspected.value.inspection)
  if (!frame.ok) return frame
  const inspection = frame.value.inspection
  if (inspection === undefined)
    return { ok: false, diagnostics: [diagnostic('unconfirmed', 'Context negative inspection is unavailable')] }
  const histories = frame.value.histories
  const home = historyFor(inspected.value.inspection.mandate.scope, histories)
  if (home === null)
    return { ok: false, diagnostics: [diagnostic('unconfirmed', 'Context negative history is unavailable')] }
  const captured = authenticateNegativeChain(negativeChain, home, histories, inspection, context.value)
  if (!captured.ok) return captured
  const capturedPrefix = captured.value
  if (negativeLeaf.payload.phase !== 'result')
    return { ok: false, diagnostics: [diagnostic('unconfirmed', 'Context negative frame is absent')] }
  const accepted = resolveAcceptedSpec(input.mandate, histories, undefined, inspection, context.value)
  if (!accepted.ok) return { ok: false, diagnostics: accepted.evidence }
  return {
    ok: true,
    value: {
      ...inspected.value,
      inspection,
      histories,
      historical: context.value,
      capturedPrefix,
      accepted: accepted.spec,
      baselineCode: negativeLeaf.payload.inputs.manifest.code,
    },
  }
}

function authenticateNegativeChain(
  chain: readonly ReceiptRecord[],
  home: DecodedHistory,
  histories: readonly DecodedHistory[],
  inspection: AcceptedSpecInspection,
  historical: HistoricalAcceptedSpecContext,
): Result<AcceptedOwnSpec> {
  let capturedPrefix: AcceptedOwnSpec | undefined
  for (const result of chain) {
    const payload = result.payload
    if (payload.phase !== 'result' || !('scope' in payload.mandate))
      return { ok: false, diagnostics: [diagnostic('unconfirmed', 'Context negative mandate is unavailable')] }
    const frame = authenticateCapturedWorkFrame(
      payload.inputs,
      payload.mandate,
      histories,
      undefined,
      inspection,
      historical,
    )
    if (!frame.ok) return frame
    if (
      capturedPrefix !== undefined &&
      canonicalValueDigest(capturedPrefix) !== canonicalValueDigest(frame.value.prefix)
    )
      return {
        ok: false,
        diagnostics: [diagnostic('unconfirmed', 'Context negative chain changed its accepted frame')],
      }
    capturedPrefix = frame.value.prefix
    if (payload.action === 'plan-review') {
      const review = authenticateNegativeReview(result, payload, frame.value, home, histories, inspection, historical)
      if (!review.ok) return review
    }
  }
  return capturedPrefix === undefined
    ? { ok: false, diagnostics: [diagnostic('unconfirmed', 'Context negative frame is absent')] }
    : { ok: true, value: capturedPrefix }
}

function authenticateNegativeReview(
  result: ReceiptRecord,
  payload: Extract<ReceiptRecord['payload'], { action: 'plan-review'; phase: 'result' }>,
  frame: { mandate: MandateRecord; prefix: AcceptedOwnSpec },
  home: DecodedHistory,
  histories: readonly DecodedHistory[],
  inspection: AcceptedSpecInspection,
  historical: HistoricalAcceptedSpecContext,
): Result<void> {
  const pair = authenticateWorkflowReceiptPair(home, result)
  if (!pair.ok) return pair
  const drafts = recordsOf(home).filter(
    (record): record is ReceiptRecord =>
      record.kind === 'action-receipt' &&
      record.payload.action === 'plan' &&
      record.payload.phase === 'result' &&
      record.payload.actionId === payload.exactInputs.draftActionId &&
      sameRef(record.payload.mandate, payload.mandate),
  )
  const draft = drafts[0]
  if (drafts.length !== 1 || draft === undefined || draft.payload.action !== 'plan' || draft.payload.phase !== 'result')
    return { ok: false, diagnostics: [diagnostic('unconfirmed', 'Context negative draft is unavailable')] }
  const draftFrame = authenticateCapturedWorkFrame(
    draft.payload.inputs,
    draft.payload.mandate,
    histories,
    undefined,
    inspection,
    historical,
  )
  if (
    !draftFrame.ok ||
    canonicalValueDigest(draftFrame.value.prefix) !== canonicalValueDigest(frame.prefix) ||
    canonicalValueDigest(draft.payload.inputs.manifest.spec) !== canonicalValueDigest(payload.inputs.manifest.spec)
  )
    return { ok: false, diagnostics: [diagnostic('unconfirmed', 'Context negative draft frame differs')] }
  const specialists = inspectPlanSpecialists(
    { history: home, start: pair.value.start, result, frame },
    payload,
    draft,
    histories,
    undefined,
    inspection,
    historical,
  )
  return specialists.ok ? { ok: true, value: undefined } : specialists
}
