import { missingContextOf } from './action-context.ts'
import { canonicalValueDigest, validateActionInputs } from './action-input.ts'
import { citedOperationIntegrity, nativeResultValid } from './delivery-eligibility.ts'
import type { DecodedHistory } from './history-schema.ts'
import { producerOutputValid } from './producer-schema.ts'
import { equalScope } from './record-diagnostics.ts'
import { reviewContextPairValid } from './workflow-context-review.ts'
import { type ReceiptRecord, recordsOf } from './workflow-control.ts'
import { implementationOutputSchema } from './workflow-output-schema.ts'

const outputFor = {
  frame: 'spec',
  plan: 'plan',
  'assess-spec': 'spec-assessment',
  'attribute-ci': 'ci-attribution',
  implement: 'implementation',
  normalize: 'uw-normalization',
} as const

export function workflowContextNegative(result: ReceiptRecord): boolean {
  const payload = result.payload
  if (payload.phase !== 'result') return false
  if (payload.action === 'plan-review') {
    return (
      (producerOutputValid('plan-review', payload.structured) && missingContextOf(payload.structured) !== null) ||
      payload.contributions.some(
        (contribution) =>
          producerOutputValid('plan-review', contribution.structured) &&
          missingContextOf(contribution.structured) !== null,
      )
    )
  }
  if (!(payload.action in outputFor)) return false
  const output = outputFor[payload.action as keyof typeof outputFor]
  return (
    (producerOutputValid(output, payload.structured) ||
      (payload.action === 'implement' && implementationOutputSchema.safeParse(payload.structured).success)) &&
    missingContextOf(payload.structured) !== null
  )
}

function paired(history: DecodedHistory, result: ReceiptRecord, receipts: readonly ReceiptRecord[]): boolean {
  const payload = result.payload
  if (
    payload.phase !== 'result' ||
    !nativeResultValid(result) ||
    citedOperationIntegrity(history, result.recordId) !== null
  )
    return false
  if (workflowContextNegative(result) && payload.admission !== null) return false
  const starts = matchingReceipts(receipts, result, 'start')
  if (starts.length !== 1 || matchingReceipts(receipts, result, 'result').length !== 1) return false
  const start = starts[0]
  if (start === undefined || start.payload.phase !== 'start') return false
  if (!reviewContextPairValid(start, result, workflowContextNegative(result))) return false
  return (
    payload.start.kind === 'action-receipt' &&
    payload.start.recordId === start.recordId &&
    equalScope(payload.start.scope, history.source.scope) &&
    citedOperationIntegrity(history, start.recordId) === null &&
    validateActionInputs(payload.inputs).ok &&
    canonicalValueDigest(start.payload.inputs) === canonicalValueDigest(payload.inputs) &&
    canonicalValueDigest(start.payload.exactInputs) === canonicalValueDigest(payload.exactInputs) &&
    canonicalValueDigest(start.payload.mandate) === canonicalValueDigest(payload.mandate)
  )
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

function succeeds(history: DecodedHistory, old: ReceiptRecord, candidate: ReceiptRecord): boolean {
  if (
    old.payload.phase !== 'result' ||
    candidate.payload.phase !== 'result' ||
    old.payload.action !== candidate.payload.action ||
    old.payload.actionId === candidate.payload.actionId
  )
    return false
  let oldInputs = old.payload.inputs
  let newInputs = candidate.payload.inputs
  if (old.payload.action === 'plan-review' && candidate.payload.action === 'plan-review') {
    const contribution = old.payload.contributions.find(
      (item) => producerOutputValid('plan-review', item.structured) && missingContextOf(item.structured) !== null,
    )
    const oldSlot = old.payload.slots.find((slot) => slot.slotId === contribution?.host.slotId)
    const newSlot = candidate.payload.slots.find(
      (slot) => slot.slotId === oldSlot?.slotId && slot.specialist === oldSlot?.specialist,
    )
    if (oldSlot?.action == null || newSlot?.action == null || oldSlot.action.actionId === newSlot.action.actionId)
      return false
    oldInputs = oldSlot.action.inputs
    newInputs = newSlot.action.inputs
  }
  if (oldInputs.fingerprint === newInputs.fingerprint || !validateActionInputs(newInputs).ok) return false
  if (
    canonicalValueDigest(old.payload.exactInputs) !== canonicalValueDigest(candidate.payload.exactInputs) ||
    canonicalValueDigest(old.payload.mandate) !== canonicalValueDigest(candidate.payload.mandate)
  )
    return false
  const previous = oldInputs.manifest
  const next = newInputs.manifest
  const { expandedContext: oldRefs, ...oldAuthority } = previous
  const { expandedContext: newRefs, ...newAuthority } = next
  if (
    canonicalValueDigest(oldAuthority) !== canonicalValueDigest(newAuthority) ||
    canonicalValueDigest(oldInputs.stageSources) !== canonicalValueDigest(newInputs.stageSources)
  )
    return false
  if (!oldRefs.every((ref) => newRefs.some((nextRef) => canonicalValueDigest(ref) === canonicalValueDigest(nextRef))))
    return false
  const lineage = newRefs.filter(
    (ref) =>
      ref.source === 'record' &&
      ref.selector === '/payload' &&
      ref.record.kind === 'action-receipt' &&
      ref.record.recordId === old.recordId &&
      equalScope(ref.record.scope, history.source.scope) &&
      ref.digest === canonicalValueDigest(old.payload),
  )
  if (lineage.length !== 1) return false
  const priorRefs = [
    ...oldRefs,
    ...previous.acceptedSources,
    ...previous.deliveryData.map(({ role: _role, ...ref }) => ref),
    ...previous.repositoryReferences,
    ...oldInputs.stageSources,
  ]
  return newRefs.some(
    (ref) =>
      canonicalValueDigest(ref) !== canonicalValueDigest(lineage[0]) &&
      !priorRefs.some((oldRef) => canonicalValueDigest(oldRef) === canonicalValueDigest(ref)),
  )
}

/** Negative results terminalize their start, but only a unique, explicitly linked result supersedes them. */
export function workflowContextTerminal(
  history: DecodedHistory,
  action: string,
  contextLeaf?: ReceiptRecord,
): 'clear' | 'missing' | 'uncertain' | 'ambiguous' {
  const receipts = recordsOf(history).filter(
    (record): record is ReceiptRecord => record.kind === 'action-receipt' && record.payload.action === action,
  )
  const negatives = receipts.filter(workflowContextNegative)
  for (const item of negatives) {
    const resolution = resolveContextNegative(history, item, receipts, new Set())
    if (resolution === 'missing' && contextLeaf !== undefined) {
      const chain = workflowContextChain(history, item)
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
export function workflowContextResolution(history: DecodedHistory, negative: ReceiptRecord): ContextResolution {
  const receipts = recordsOf(history).filter(
    (record): record is ReceiptRecord =>
      record.kind === 'action-receipt' && record.payload.action === negative.payload.action,
  )
  const matches = receipts.filter((record) => record.recordId === negative.recordId)
  if (matches.length !== 1 || canonicalValueDigest(matches[0]) !== canonicalValueDigest(negative)) return 'uncertain'
  return resolveContextNegative(history, negative, receipts, new Set())
}

/** Identify the immediate authenticated successor, including a still-negative successor. */
export function workflowContextDirectSuccessor(
  history: DecodedHistory,
  negative: ReceiptRecord,
): { status: 'successor'; record: ReceiptRecord } | { status: 'missing' | 'uncertain' | 'ambiguous' } {
  const receipts = recordsOf(history).filter(
    (record): record is ReceiptRecord =>
      record.kind === 'action-receipt' && record.payload.action === negative.payload.action,
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
): { status: ContextResolution; negatives: ReceiptRecord[]; leaf: ReceiptRecord } {
  const negatives: ReceiptRecord[] = []
  const seen = new Set<string>()
  let current = negative
  while (true) {
    if (seen.has(current.recordId)) return { status: 'uncertain', negatives, leaf: current }
    seen.add(current.recordId)
    negatives.push(current)
    const direct = workflowContextDirectSuccessor(history, current)
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
): ContextResolution {
  if (!workflowContextNegative(negative) || seen.has(negative.recordId) || !paired(history, negative, receipts))
    return 'uncertain'
  seen.add(negative.recordId)
  const successors = receipts.filter((candidate) => succeeds(history, negative, candidate))
  if (successors.length > 1) return 'ambiguous'
  if (hasUnpairedStart(receipts)) return 'uncertain'
  const successor = successors[0]
  if (successor === undefined) return 'missing'
  if (!paired(history, successor, receipts)) return 'uncertain'
  if (workflowContextNegative(successor)) return resolveContextNegative(history, successor, receipts, seen)
  return validPositiveSuccessor(successor) ? 'clear' : 'uncertain'
}

function hasUnpairedStart(receipts: readonly ReceiptRecord[]): boolean {
  return receipts.some(
    (record) =>
      record.payload.phase === 'start' &&
      !receipts.some(
        (result) => result.payload.phase === 'result' && result.payload.actionId === record.payload.actionId,
      ),
  )
}

function validPositiveSuccessor(successor: ReceiptRecord): boolean {
  const payload = successor.payload
  if (payload.phase !== 'result') return false
  if (payload.action === 'plan-review') return positiveReviewSuccessor(payload)
  if (payload.action === 'implement') {
    const parsed = implementationOutputSchema.safeParse(payload.structured)
    return (
      parsed.success &&
      parsed.data.outcome === 'implemented' &&
      payload.admission?.admitted === true &&
      payload.admission.remoteTip !== null
    )
  }
  if (payload.action === 'frame' && payload.structured === null) return true
  if (!(payload.action in outputFor)) return true
  const output = outputFor[payload.action as keyof typeof outputFor]
  return producerOutputValid(output, payload.structured)
}

function positiveReviewSuccessor(
  payload: Extract<ReceiptRecord['payload'], { action: 'plan-review'; phase: 'result' }>,
): boolean {
  return (
    payload.slots.every((slot) => {
      const contributions = payload.contributions.filter((contribution) => contribution.host.slotId === slot.slotId)
      const contribution = contributions[0]
      return (
        contributions.length === 1 &&
        contribution !== undefined &&
        producerOutputValid('plan-review', contribution.structured) &&
        missingContextOf(contribution.structured) === null
      )
    }) && payload.contributions.length === payload.slots.length
  )
}
