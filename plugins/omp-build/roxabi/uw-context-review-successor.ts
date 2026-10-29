import { recordOperation } from '../adapters/github/record-integrity.ts'
import { missingContextOutputSchema } from '../engine/action-context.ts'
import { canonicalValueDigest, validateActionInputs } from '../engine/action-input.ts'
import type { ActionInputs, RecordInputRef } from '../engine/action-input-schema.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import { producerOutputValid } from '../engine/producer-schema.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { Slot } from '../engine/record-values.ts'
import type { Result } from '../engine/result.ts'
import { directReviewContextSuccessors } from '../engine/review-context-lineage.ts'
import { bindExternalRef, historyFor } from '../engine/workflow-control.ts'
import type { UwActionRequest } from './uw-action-contract.ts'
import { authenticate } from './uw-action-observe.ts'
import { actionFailure } from './uw-action-result.ts'

type Contribution = Extract<CanonicalRecord, { kind: 'contribution' }>
type Inventory = Extract<CanonicalRecord, { kind: 'review-attempt' }>
export const equal = (a: unknown, b: unknown): boolean => canonicalValueDigest(a) === canonicalValueDigest(b)
export const sameScope = (
  a: { repository: string; target: string },
  b: { repository: string; target: string },
): boolean => a.repository === b.repository && a.target === b.target
export const contextIdentity = (
  ref: ActionInputs['manifest']['expandedContext'][number] | ActionInputs['manifest']['deliveryData'][number],
): string =>
  ref.source === 'git-file'
    ? canonicalValueDigest(ref)
    : canonicalValueDigest({ source: ref.source, record: ref.record, selector: ref.selector, digest: ref.digest })

export function accounted(record: CanonicalRecord, histories: readonly DecodedHistory[]): boolean {
  const history = historyFor(record, histories)
  if (history === null) return false
  const matches = history.operations.filter(
    (op) => op.recordId === record.recordId || op.operationId === record.operationId,
  )
  const operation = matches[0]
  return (
    matches.length === 1 &&
    operation?.status === 'complete' &&
    operation.authority !== 'foreign' &&
    operation.record !== null &&
    equal(operation.record, record) &&
    recordOperation(histories, record) === operation &&
    authenticate(record, histories).ok &&
    bindExternalRef({ scope: history.source.scope, kind: record.kind, recordId: record.recordId }, history).ok
  )
}

export function matchesNativeSlot(
  record: Contribution,
  inventory: Inventory,
  slot: Slot,
  binding: NonNullable<Contribution['payload']['host']['action']>,
): boolean {
  const body = record.payload
  return (
    slot.action !== undefined &&
    equal(slot.action, binding) &&
    record.inputs.includes(inventory.recordId) &&
    body.host.origin === 'native' &&
    body.host.childId !== null &&
    body.host.phase === slot.phase &&
    body.host.role === slot.role &&
    body.host.chunk === slot.chunk &&
    body.native?.completion === 'completed' &&
    body.native.strict === 'valid' &&
    producerOutputValid(slot.output, body.structured) &&
    body.rawAttempts.some((attempt) => equal(attempt.data, body.structured)) &&
    validateActionInputs(binding.inputs).ok &&
    inventory.payload.actionInputDigest === binding.inputs.fingerprint &&
    inventory.payload.candidateGitSHA === binding.inputs.manifest.code.head
  )
}

function lineageSlot(
  root: Inventory,
  inputSnapshot: ActionInputs,
  negativeSlot: Slot,
  contributions: readonly Contribution[],
  histories: readonly DecodedHistory[],
): Result<{ entry: Contribution; negative: boolean }> {
  const entries = contributions.filter(
    (entry) =>
      sameScope(entry, root) &&
      entry.payload.inventoryId === root.recordId &&
      entry.payload.host.slotId === negativeSlot.slotId,
  )
  const entry = entries[0]
  const slots = root.payload.slots.filter((slot) => slot.slotId === negativeSlot.slotId)
  const slot = slots[0]
  const negative = missingContextOutputSchema.safeParse(entry?.payload.structured).success
  const binding = negative ? entry?.payload.host.action : slot?.action
  if (
    entries.length !== 1 ||
    entry === undefined ||
    slots.length !== 1 ||
    slot === undefined ||
    !accounted(root, histories) ||
    !accounted(entry, histories) ||
    binding === undefined ||
    (!negative && entry.payload.host.action !== undefined && !equal(entry.payload.host.action, binding)) ||
    !matchesNativeSlot(entry, root, slot, binding) ||
    !equal(binding.inputs, inputSnapshot)
  )
    return actionFailure('record-unreadable', 'Review context lineage has an unauthenticated slot')
  return { ok: true, value: { entry, negative } }
}

function negativeInventoryValid(
  root: Inventory,
  contributions: readonly Contribution[],
  records: readonly CanonicalRecord[],
): Result<null> {
  if (
    contributions.filter(
      (candidate) =>
        sameScope(candidate, root) &&
        candidate.payload.inventoryId === root.recordId &&
        missingContextOutputSchema.safeParse(candidate.payload.structured).success,
    ).length !== 1
  )
    return actionFailure('record-unreadable', 'Review inventory has ambiguous negative contributions')
  if (records.some((record) => record.kind === 'review' && record.payload.inventoryIds.includes(root.recordId)))
    return actionFailure('record-unreadable', 'Context-negative review inventory has a final review')
  return { ok: true, value: null }
}

function completedBaseline(
  request: UwActionRequest,
  root: Inventory,
  inputSnapshot: ActionInputs,
  advanced: boolean,
): Result<{ inputs: ActionInputs; rootAttemptId: string; current: boolean } | null> {
  if (!advanced) return { ok: true, value: null }
  const current =
    request.purpose === 'review' &&
    (request.actionId === `${root.recordId}:synthesis` || request.actionId.startsWith(`${root.recordId}:recall:`))
  return { ok: true, value: { inputs: inputSnapshot, rootAttemptId: root.recordId, current } }
}

type Baseline = { inputs: ActionInputs; rootAttemptId: string; current: boolean } | null

function lineageStep(
  request: UwActionRequest,
  root: Inventory,
  negativeSlot: Slot,
  contributions: readonly Contribution[],
  records: readonly CanonicalRecord[],
  histories: readonly DecodedHistory[],
  history: DecodedHistory,
  roots: readonly Inventory[],
  seen: Set<string>,
  advanced: boolean,
): Result<{ next: Inventory } | { done: Baseline }> {
  if (root.payload.stage !== 'initial' || root.payload.purpose !== 'review')
    return actionFailure('record-unreadable', 'Review context lineage has a mismatched root')
  if (seen.has(root.recordId)) return actionFailure('action-input-cycle', 'Review context lineage contains a cycle')
  seen.add(root.recordId)
  const slot = lineageSlot(root, root.payload.inputSnapshot, negativeSlot, contributions, histories)
  if (!slot.ok) return slot
  if (!slot.value.negative) {
    const baseline = completedBaseline(request, root, root.payload.inputSnapshot, advanced)
    if (!baseline.ok) return baseline
    return { ok: true, value: { done: baseline.value } }
  }
  const valid = negativeInventoryValid(root, contributions, records)
  if (!valid.ok) return valid
  const successors = directReviewContextSuccessors(history, roots, contributions, root, slot.value.entry)
  if (successors.length > 1)
    return actionFailure('record-unreadable', 'Negative contribution has competing successor roots')
  const successor = successors[0]
  if (successor === undefined)
    return {
      ok: true,
      value: {
        done: advanced ? { inputs: root.payload.inputSnapshot, rootAttemptId: root.recordId, current: false } : null,
      },
    }
  return { ok: true, value: { next: successor } }
}

/** Follow authenticated direct negative links; stage authorization belongs to the dispatcher. */
export function laterReviewBaseline(
  request: UwActionRequest,
  records: readonly CanonicalRecord[],
  histories: readonly DecodedHistory[],
  negativeRoot: Inventory,
  negativeSlot: Slot,
  _negativeInputs: ActionInputs,
  _ref: RecordInputRef,
): Result<{ inputs: ActionInputs; rootAttemptId: string; current: boolean } | null> {
  const history = historyFor(negativeRoot, histories)
  if (history === null) return actionFailure('record-unreadable', 'Negative review history is unavailable')
  const roots = records.filter(
    (item): item is Inventory =>
      item.kind === 'review-attempt' &&
      sameScope(item, negativeRoot) &&
      item.payload.stage === 'initial' &&
      item.payload.purpose === 'review',
  )
  const contributions = records.filter((item): item is Contribution => item.kind === 'contribution')
  let root = negativeRoot
  let advanced = false
  const seen = new Set<string>()
  while (true) {
    const step = lineageStep(
      request,
      root,
      negativeSlot,
      contributions,
      records,
      histories,
      history,
      roots,
      seen,
      advanced,
    )
    if (!step.ok) return step
    if ('done' in step.value) return { ok: true, value: step.value.done }
    root = step.value.next
    advanced = true
  }
}
