import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, fail, sameRef } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { Result } from './result.ts'
import {
  type ControlRecord,
  historyFor,
  type MandateRecord,
  mandateScope,
  type ReceiptRecord,
  receiptStartKey,
  recordsOf,
  scopedStartKey,
} from './workflow-control.ts'
import {
  authenticateInterruptedReceiptPair,
  INTERRUPTION_ACTIONS,
  type InterruptionAction,
  type InterruptionResolution,
  interruptedResult,
  invalidResolution,
  isInterruptionAction,
  type ResolutionPayload,
} from './workflow-interruption-proof.ts'
import { resolutionIndex } from './workflow-interruption-resolution.ts'
import { unliftedPause } from './workflow-pause.ts'
import type { ActionCompletion } from './workflow-plan.ts'

export type UnresolvedAttempt =
  | { kind: 'orphan'; action: InterruptionAction; start: ReceiptRecord }
  | { kind: 'interrupted'; action: InterruptionAction; start: ReceiptRecord; result: ReceiptRecord }
export type AttemptClassification = {
  readonly excluded: ReadonlySet<string>
  readonly unresolved: readonly UnresolvedAttempt[]
}
export type InterruptionGate =
  | { kind: 'clear'; excluded: ReadonlySet<string> }
  | { kind: 'stop'; completion: ActionCompletion }
export type ResolvableStart = { action: InterruptionAction; start: ReceiptRecord; result: ReceiptRecord | null }
export type ResolutionCandidate = {
  action: InterruptionAction
  actionId: string
  start: ReceiptRecord
  result: ReceiptRecord | null
  /** The current unlifted pause-confirmed control; publication requires it. */
  pause: ControlRecord
  runtime: ResolutionPayload['runtime']
}

function mandateRefOf(mandate: MandateRecord): ExternalRecordRef {
  return { scope: mandateScope(mandate), recordId: mandate.recordId, kind: 'mandate' }
}

/** `ok:true,value:null` means proven absent; any invalid or ambiguous state is `ok:false`. */
export function startResolution(
  histories: readonly DecodedHistory[],
  start: ExternalRecordRef,
): Result<InterruptionResolution | null> {
  const home = historyFor(start.scope, histories)
  if (home === null || !home.source.complete)
    return fail([invalidResolution(null, 'V3', 'START history is missing or incomplete')])
  const index = resolutionIndex(histories)
  if (!index.ok) return index
  return { ok: true, value: index.value.resolved.get(scopedStartKey(start)) ?? null }
}

function receiptsOf(history: DecodedHistory): ReceiptRecord[] {
  return recordsOf(history).filter((record): record is ReceiptRecord => record.kind === 'action-receipt')
}

/**
 * Classify the selector's attempts before it reads them. A resolved START (and its RESULT) is excluded from
 * progression only; an unresolved START is an orphan when it has no RESULT, interrupted when its unique RESULT
 * is a typed interrupted RESULT. Any other RESULT stays with the selector's existing rules.
 */
export function classifyAttempts(input: {
  histories: readonly DecodedHistory[]
  scan: readonly DecodedHistory[]
  actions: readonly InterruptionAction[]
  select?: (receipt: ReceiptRecord) => boolean
}): Result<AttemptClassification> {
  if (input.scan.some((history) => !history.source.complete))
    return fail([invalidResolution(null, 'V3', 'Attempt history is incomplete')])
  const index = resolutionIndex([...input.histories, ...input.scan.filter((item) => !input.histories.includes(item))])
  if (!index.ok) return index
  const excluded = new Set<string>()
  const unresolved: UnresolvedAttempt[] = []
  for (const history of input.scan) {
    const receipts = receiptsOf(history).filter(
      (receipt) =>
        isInterruptionAction(receipt.payload.action) &&
        input.actions.includes(receipt.payload.action) &&
        (input.select?.(receipt) ?? true),
    )
    const classified = classifyHistoryAttempts(history, receipts, index.value.resolved, excluded, unresolved)
    if (!classified.ok) return classified
  }
  return { ok: true, value: { excluded, unresolved } }
}

function classifyHistoryAttempts(
  history: DecodedHistory,
  receipts: readonly ReceiptRecord[],
  resolved: ReadonlyMap<string, InterruptionResolution>,
  excluded: Set<string>,
  unresolved: UnresolvedAttempt[],
): Result<void> {
  if (receipts.some(legacyInterruptionResult))
    return fail([diagnostic('action-uncertain', 'Legacy interruption proof is not executable')])
  for (const start of receipts) {
    const action = start.payload.action
    if (start.payload.phase !== 'start' || !isInterruptionAction(action)) continue
    const key = receiptStartKey(start)
    if (resolved.has(key)) {
      excluded.add(key)
      continue
    }
    const attempt = classifyUnresolvedStart(history, receipts, start, action)
    if (!attempt.ok) return attempt
    if (attempt.value !== null) unresolved.push(attempt.value)
  }
  return { ok: true, value: undefined }
}

function classifyUnresolvedStart(
  history: DecodedHistory,
  receipts: readonly ReceiptRecord[],
  start: ReceiptRecord,
  action: InterruptionAction,
): Result<UnresolvedAttempt | null> {
  const results = receipts.filter(
    (receipt) =>
      receipt.payload.phase === 'result' &&
      receipt.payload.action === action &&
      receipt.payload.actionId === start.payload.actionId,
  )
  const result = results[0]
  if (result === undefined) return { ok: true, value: { kind: 'orphan', action, start } }
  if (results.length === 1 && authenticateInterruptedReceiptPair(history, result).ok)
    return { ok: true, value: { kind: 'interrupted', action, start, result } }
  if (results.some(interruptedResult))
    return fail([diagnostic('action-uncertain', `${action} interrupted receipt pairing is not authenticated`)])
  return { ok: true, value: null }
}

function legacyInterruptionResult(receipt: ReceiptRecord): boolean {
  return (
    receipt.payload.phase === 'result' &&
    receipt.payload.diagnostics.some((entry) => {
      const detail = entry.detail
      return (
        typeof detail === 'object' &&
        detail !== null &&
        !Array.isArray(detail) &&
        detail.marker === 'omp-build-host-interruption/1'
      )
    })
  )
}

/** Index problems block as invalid, interrupted attempts block, orphans stay uncertain. */
export function interruptionGate(classified: Result<AttemptClassification>): InterruptionGate {
  if (!classified.ok) return { kind: 'stop', completion: { status: 'blocked', evidence: classified.diagnostics } }
  const interrupted = classified.value.unresolved.find((attempt) => attempt.kind === 'interrupted')
  if (interrupted?.kind === 'interrupted')
    return {
      kind: 'stop',
      completion: {
        status: 'blocked',
        evidence: [
          {
            code: 'action-interrupted',
            message: `${interrupted.action} attempt was interrupted and awaits an operator resolution`,
            recordId: interrupted.result.recordId,
            detail: { action: interrupted.action, start: interrupted.start.recordId },
          },
        ],
      },
    }
  const orphan = classified.value.unresolved.find((attempt) => attempt.kind === 'orphan')
  if (orphan !== undefined)
    return {
      kind: 'stop',
      completion: {
        status: 'uncertain',
        evidence: [
          {
            code: 'action-uncertain',
            message: `${orphan.action} start has no result`,
            recordId: orphan.start.recordId,
            detail: { action: orphan.action },
          },
        ],
      },
    }
  return { kind: 'clear', excluded: classified.value.excluded }
}

function mandateAttempt(mandate: MandateRecord): (receipt: ReceiptRecord) => boolean {
  const ref = mandateRefOf(mandate)
  return (receipt) => 'scope' in receipt.payload.mandate && sameRef(receipt.payload.mandate, ref)
}

/** Unresolved attempts of one mandate across the supplied histories (issue and pull request). */
export function resolvableStarts(
  histories: readonly DecodedHistory[],
  mandate: MandateRecord,
): Result<readonly ResolvableStart[]> {
  const scan = histories.filter((history) =>
    receiptsOf(history).some((receipt) => isInterruptionAction(receipt.payload.action)),
  )
  const classified = classifyAttempts({
    histories,
    scan,
    actions: INTERRUPTION_ACTIONS,
    select: mandateAttempt(mandate),
  })
  if (!classified.ok) return classified
  return {
    ok: true,
    value: classified.value.unresolved.map((attempt) => ({
      action: attempt.action,
      start: attempt.start,
      result: attempt.kind === 'interrupted' ? attempt.result : null,
    })),
  }
}

/** Describe one unresolved attempt under the current unlifted pause. */
export function interruptionResolutionCandidate(input: {
  histories: readonly DecodedHistory[]
  mandate: MandateRecord
  start: ExternalRecordRef
}): Result<ResolutionCandidate> {
  const refuse = (rule: string, message: string) => fail([invalidResolution(null, rule, message)])
  const existing = startResolution(input.histories, input.start)
  if (!existing.ok) return existing
  if (existing.value !== null) return refuse('V3', 'START is already resolved')
  const mandateHome = historyFor(mandateScope(input.mandate), input.histories)
  const pause = mandateHome === null ? null : unliftedPause(mandateHome, input.mandate)
  if (pause === null) return refuse('V4', 'Resolution requires the mandate to be paused')
  const attempts = resolvableStarts(input.histories, input.mandate)
  if (!attempts.ok) return attempts
  const attempt = attempts.value.find((item) => scopedStartKey(input.start) === receiptStartKey(item.start))
  if (attempt === undefined) return refuse('V3', 'START is not an unresolved attempt of this mandate')
  const { start, result, action } = attempt
  const config = input.mandate.payload.config
  const runtime = { productVersion: config.productVersion, configVersion: config.version, configDigest: config.digest }
  return { ok: true, value: { action, actionId: start.payload.actionId, start, result, pause, runtime } }
}
