import { canonicalValueDigest, validateActionInputs } from './action-input.ts'
import { citedOperationIntegrity, nativeResultValid } from './delivery-eligibility.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope } from './record-diagnostics.ts'
import type { Result } from './result.ts'
import { succeeds } from './workflow-context-lineage.ts'
import { validPositiveSuccessor, workflowContextNegative } from './workflow-context-output.ts'
import { authenticatedContextReplayStart, hasUnpairedStart } from './workflow-context-replay.ts'
import { reviewContextPairValid } from './workflow-context-review.ts'
import { bindExternalRef, excludedReceipt, type ReceiptRecord, recordsOf } from './workflow-control.ts'

/**
 * Authenticate the unique START/RESULT pair of one invocation. `native: 'unchecked'` is reserved for the
 * interruption authority, which separately requires a typed interrupted RESULT; every other caller requires a
 * valid native result.
 */
export function authenticateWorkflowReceiptPair(
  history: DecodedHistory,
  result: ReceiptRecord,
  options: { native: 'valid' | 'unchecked' } = { native: 'valid' },
): Result<{ start: ReceiptRecord; result: ReceiptRecord }> {
  const refusal = (): Result<never> => ({
    ok: false,
    diagnostics: [diagnostic('unconfirmed', 'Workflow receipt pair is not uniquely authenticated')],
  })
  const payload = result.payload
  if (
    payload.phase !== 'result' ||
    !history.source.complete ||
    (options.native === 'valid' && !nativeResultValid(result)) ||
    citedOperationIntegrity(history, result.recordId) !== null ||
    (workflowContextNegative(result) && payload.admission !== null)
  )
    return refusal()
  const operations = history.operations.filter(
    (operation) =>
      operation.authority !== 'foreign' &&
      operation.record?.kind === 'action-receipt' &&
      operation.record.payload.action === payload.action &&
      operation.record.payload.actionId === payload.actionId,
  )
  if (
    operations.length !== 2 ||
    operations.some((operation) => operation.authority !== 'accounted' || operation.status !== 'complete')
  )
    return refusal()
  const receipts = operations
    .map((operation) => operation.record)
    .filter((record): record is ReceiptRecord => record !== null && record.kind === 'action-receipt')
  const starts = matchingReceipts(receipts, result, 'start')
  if (starts.length !== 1 || matchingReceipts(receipts, result, 'result').length !== 1) return refusal()
  const start = starts[0]
  if (
    start === undefined ||
    start.payload.phase !== 'start' ||
    !reviewContextPairValid(start, result, workflowContextNegative(result))
  )
    return refusal()
  const boundStart = bindExternalRef(
    { scope: history.source.scope, kind: 'action-receipt', recordId: start.recordId },
    history,
  )
  const boundResult = bindExternalRef(
    { scope: history.source.scope, kind: 'action-receipt', recordId: result.recordId },
    history,
  )
  if (
    !boundStart.ok ||
    !boundResult.ok ||
    canonicalValueDigest(boundResult.value) !== canonicalValueDigest(result) ||
    payload.start.kind !== 'action-receipt' ||
    payload.start.recordId !== start.recordId ||
    !equalScope(payload.start.scope, history.source.scope) ||
    citedOperationIntegrity(history, start.recordId) !== null ||
    !validateActionInputs(payload.inputs).ok ||
    canonicalValueDigest(start.payload.inputs) !== canonicalValueDigest(payload.inputs) ||
    canonicalValueDigest(start.payload.exactInputs) !== canonicalValueDigest(payload.exactInputs) ||
    canonicalValueDigest(start.payload.mandate) !== canonicalValueDigest(payload.mandate)
  )
    return refusal()
  return { ok: true, value: { start, result } }
}

function paired(history: DecodedHistory, result: ReceiptRecord, _receipts: readonly ReceiptRecord[]): boolean {
  return authenticateWorkflowReceiptPair(history, result).ok
}

function matchingReceipts(
  receipts: readonly ReceiptRecord[],
  result: ReceiptRecord,
  phase: 'start' | 'result',
): ReceiptRecord[] {
  return receipts.filter(
    (record) =>
      record.payload.phase === phase &&
      record.payload.action === result.payload.action &&
      record.payload.actionId === result.payload.actionId,
  )
}

/**
 * Negative results terminalize their start, but only a unique, explicitly linked result supersedes them.
 * `excluded` holds exact scoped START keys of resolved interrupted attempts; they leave successor selection only.
 */
export function workflowContextTerminal(
  history: DecodedHistory,
  action: string,
  contextLeaf?: ReceiptRecord,
  excluded?: ReadonlySet<string>,
): 'clear' | 'missing' | 'uncertain' | 'ambiguous' {
  return contextTerminal(history, action, contextLeaf, undefined, excluded)
}

/** Observes a pending assessment only for replay; it does not terminalize the negative. */
export function observeAssessmentContextReplay(
  history: DecodedHistory,
  replayStart: ReceiptRecord,
  excluded?: ReadonlySet<string>,
): 'observed' | 'missing' | 'uncertain' | 'ambiguous' {
  if (!authenticatedContextReplayStart(history, replayStart)) return 'uncertain'
  const result = contextTerminal(history, 'assess-spec', undefined, replayStart, excluded)
  return result === 'clear' ? 'observed' : result
}

function contextTerminal(
  history: DecodedHistory,
  action: string,
  contextLeaf?: ReceiptRecord,
  replayStart?: ReceiptRecord,
  excluded?: ReadonlySet<string>,
): 'clear' | 'missing' | 'uncertain' | 'ambiguous' {
  const receipts = recordsOf(history).filter(
    (record): record is ReceiptRecord =>
      record.kind === 'action-receipt' && record.payload.action === action && !excludedReceipt(record, excluded),
  )
  if (
    replayStart !== undefined &&
    (action !== 'assess-spec' ||
      replayStart.payload.action !== 'assess-spec' ||
      replayStart.payload.phase !== 'start' ||
      !receipts.includes(replayStart))
  )
    return 'uncertain'
  const negatives = receipts.filter(workflowContextNegative)
  for (const item of negatives) {
    const resolution = resolveContextNegative(history, item, receipts, new Set(), replayStart)
    if (resolution === 'missing' && contextLeaf !== undefined) {
      const chain = workflowContextChain(history, item, excluded)
      if (
        chain.status === 'missing' &&
        chain.leaf.recordId === contextLeaf.recordId &&
        canonicalValueDigest(chain.leaf) === canonicalValueDigest(contextLeaf)
      )
        continue
    }
    if (resolution !== 'clear') return resolution
  }
  return 'clear'
}

type ContextResolution = 'clear' | 'missing' | 'uncertain' | 'ambiguous'

/** Classify one exact retained negative; `clear` requires its unique authenticated positive lineage. */
export function workflowContextResolution(
  history: DecodedHistory,
  negative: ReceiptRecord,
  excluded?: ReadonlySet<string>,
): ContextResolution {
  const receipts = recordsOf(history).filter(
    (record): record is ReceiptRecord =>
      record.kind === 'action-receipt' &&
      record.payload.action === negative.payload.action &&
      !excludedReceipt(record, excluded),
  )
  const matches = receipts.filter((record) => record.recordId === negative.recordId)
  if (matches.length !== 1 || canonicalValueDigest(matches[0]) !== canonicalValueDigest(negative)) return 'uncertain'
  return resolveContextNegative(history, negative, receipts, new Set())
}

/** Identify the immediate authenticated successor, including a still-negative successor. */
export function workflowContextDirectSuccessor(
  history: DecodedHistory,
  negative: ReceiptRecord,
  excluded?: ReadonlySet<string>,
): { status: 'successor'; record: ReceiptRecord } | { status: 'missing' | 'uncertain' | 'ambiguous' } {
  const receipts = recordsOf(history).filter(
    (record): record is ReceiptRecord =>
      record.kind === 'action-receipt' &&
      record.payload.action === negative.payload.action &&
      !excludedReceipt(record, excluded),
  )
  const matches = receipts.filter((record) => record.recordId === negative.recordId)
  if (matches.length !== 1 || canonicalValueDigest(matches[0]) !== canonicalValueDigest(negative))
    return { status: 'uncertain' }
  if (!workflowContextNegative(negative) || !paired(history, negative, receipts)) return { status: 'uncertain' }
  const successors = receipts.filter((candidate) => succeeds(history, negative, candidate))
  if (successors.length > 1) return { status: 'ambiguous' }
  if (hasUnpairedStart(receipts)) return { status: 'uncertain' }
  const successor = successors[0]
  if (successor === undefined) return { status: 'missing' }
  if (!paired(history, successor, receipts)) return { status: 'uncertain' }
  if (!workflowContextNegative(successor) && !validPositiveSuccessor(successor)) return { status: 'uncertain' }
  return { status: 'successor', record: successor }
}

/** Trace the authenticated negative chain without projecting or modifying history. */
export function workflowContextChain(
  history: DecodedHistory,
  negative: ReceiptRecord,
  excluded?: ReadonlySet<string>,
): { status: ContextResolution; negatives: ReceiptRecord[]; leaf: ReceiptRecord } {
  const negatives: ReceiptRecord[] = []
  const seen = new Set<string>()
  let current = negative
  while (true) {
    if (seen.has(current.recordId)) return { status: 'uncertain', negatives, leaf: current }
    seen.add(current.recordId)
    negatives.push(current)
    const direct = workflowContextDirectSuccessor(history, current, excluded)
    if (direct.status !== 'successor') return { status: direct.status, negatives, leaf: current }
    if (!workflowContextNegative(direct.record)) return { status: 'clear', negatives, leaf: current }
    current = direct.record
  }
}

function resolveContextNegative(
  history: DecodedHistory,
  negative: ReceiptRecord,
  receipts: readonly ReceiptRecord[],
  seen: Set<string>,
  replayStart?: ReceiptRecord,
): ContextResolution {
  if (!workflowContextNegative(negative) || seen.has(negative.recordId) || !paired(history, negative, receipts))
    return 'uncertain'
  seen.add(negative.recordId)
  const successors = receipts.filter((candidate) => succeeds(history, negative, candidate))
  const pendingSuccessor = replayStart !== undefined && succeeds(history, negative, replayStart, true)
  if (successors.length > 1 || (successors.length > 0 && pendingSuccessor)) return 'ambiguous'
  if (hasUnpairedStart(receipts, replayStart)) return 'uncertain'
  const successor = successors[0]
  if (successor === undefined) return pendingSuccessor ? 'clear' : 'missing'
  if (!paired(history, successor, receipts)) return 'uncertain'
  if (workflowContextNegative(successor)) return resolveContextNegative(history, successor, receipts, seen, replayStart)
  return validPositiveSuccessor(successor) ? 'clear' : 'uncertain'
}
