import { canonicalValueDigest } from './action-input.ts'
import { nativeResultValid } from './delivery-observation-authentication.ts'
import { authenticateHistoricalReceiptStart } from './historical-receipt-pair.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, fail } from './record-diagnostics.ts'
import type { Result } from './result.ts'
import { succeeds } from './workflow-context-lineage.ts'
import { validPositiveSuccessor, workflowContextNegative } from './workflow-context-output.ts'
import { excludedReceipt, type ReceiptRecord, receiptStartKey, recordsOf } from './workflow-control.ts'

/**
 * Authenticate the unique START/RESULT pair of one invocation. `native: 'unchecked'` is reserved for the
 * interruption authority, which separately requires a typed interrupted RESULT, and for setting aside another
 * mandate's rejected implementation, whose native output is never admitted; every other caller requires a
 * valid native result.
 */
export function authenticateWorkflowReceiptPair(
  history: DecodedHistory,
  result: ReceiptRecord,
  options: { native: 'valid' | 'unchecked' } = { native: 'valid' },
): Result<{ start: ReceiptRecord; result: ReceiptRecord }> {
  const payload = result.payload
  const negative = workflowContextNegative(result)
  if (
    payload.phase !== 'result' ||
    (options.native === 'valid' && !nativeResultValid(result)) ||
    (negative && payload.admission !== null)
  )
    return fail([diagnostic('unconfirmed', 'Workflow receipt pair is not uniquely authenticated')])
  return authenticateHistoricalReceiptStart(history, result, [history], {
    inputs: options.native === 'unchecked' || negative ? 'structural' : 'authenticated',
  })
}

function paired(history: DecodedHistory, result: ReceiptRecord): boolean {
  return authenticateWorkflowReceiptPair(history, result).ok
}

function hasUnpairedStart(history: DecodedHistory, receipts: readonly ReceiptRecord[]): boolean {
  const terminal = new Set<string>()
  for (const receipt of receipts) {
    // A recorded outcome distinguishes a missing successor from an unfinished attempt; admitting that outcome is separate.
    if (receipt.payload.phase !== 'result') continue
    if (authenticateHistoricalReceiptStart(history, receipt, [history], { inputs: 'structural' }).ok)
      terminal.add(receiptStartKey(receipt))
  }
  return receipts.some((record) => record.payload.phase === 'start' && !terminal.has(receiptStartKey(record)))
}

/** Another mandate's negative no longer blocks, but it must still be an authenticated pair. */
function otherMandateNegativeUnpaired(
  history: DecodedHistory,
  actionReceipts: readonly ReceiptRecord[],
  scoped: readonly ReceiptRecord[],
): boolean {
  return actionReceipts.some(
    (record) => !scoped.includes(record) && workflowContextNegative(record) && !paired(history, record),
  )
}

/**
 * Negative results terminalize their start, but only a unique, explicitly linked result supersedes them.
 * `excluded` holds exact scoped START keys of resolved interrupted attempts; they leave successor selection only.
 */
export function workflowContextTerminal(
  history: DecodedHistory,
  action: string,
  mandate: ReceiptRecord['payload']['mandate'],
  excluded?: ReadonlySet<string>,
): 'clear' | 'missing' | 'uncertain' | 'ambiguous' {
  const actionReceipts = recordsOf(history).filter(
    (record): record is ReceiptRecord =>
      record.kind === 'action-receipt' && record.payload.action === action && !excludedReceipt(record, excluded),
  )
  const receipts = actionReceipts.filter(
    (record) => canonicalValueDigest(record.payload.mandate) === canonicalValueDigest(mandate),
  )
  if (otherMandateNegativeUnpaired(history, actionReceipts, receipts)) return 'uncertain'
  const negatives = receipts.filter(workflowContextNegative)
  for (const item of negatives) {
    const resolution = resolveContextNegative(history, item, receipts, new Set())
    if (resolution !== 'clear') return resolution
  }
  return 'clear'
}

type ContextResolution = 'clear' | 'missing' | 'uncertain' | 'ambiguous'

function resolveContextNegative(
  history: DecodedHistory,
  negative: ReceiptRecord,
  receipts: readonly ReceiptRecord[],
  seen: Set<string>,
): ContextResolution {
  if (!workflowContextNegative(negative) || seen.has(negative.recordId) || !paired(history, negative))
    return 'uncertain'
  seen.add(negative.recordId)
  const successors = receipts.filter((candidate) => succeeds(history, negative, candidate))
  if (successors.length > 1) return 'ambiguous'
  if (hasUnpairedStart(history, receipts)) return 'uncertain'
  const successor = successors[0]
  if (successor === undefined) return 'missing'
  if (!paired(history, successor)) return 'uncertain'
  if (workflowContextNegative(successor)) return resolveContextNegative(history, successor, receipts, seen)
  return validPositiveSuccessor(successor) ? 'clear' : 'uncertain'
}
