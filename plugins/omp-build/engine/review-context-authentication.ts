import { missingContextOutputSchema } from './action-context.ts'
import { canonicalValueDigest, validateActionInputs } from './action-input.ts'
import type { DecodedHistory } from './history-schema.ts'
import { producerOutputValid } from './producer-schema.ts'
import { equalScope } from './record-diagnostics.ts'
import { recordIntegrity } from './record-integrity.ts'
import type { CanonicalRecord } from './record-schema.ts'
import { isInitialPullRequestReviewInventory } from './review-schema.ts'

type Root = Extract<CanonicalRecord, { kind: 'review-attempt' }>
type Contribution = Extract<CanonicalRecord, { kind: 'contribution' }>
type Slot = Root['payload']['slots'][number]

export const same = (left: unknown, right: unknown): boolean =>
  canonicalValueDigest(left) === canonicalValueDigest(right)

export function accounted(history: DecodedHistory, record: CanonicalRecord): boolean {
  const matches = history.operations.filter(
    (operation) =>
      operation.authority !== 'foreign' &&
      (operation.recordId === record.recordId || operation.operationId === record.operationId),
  )
  if (matches.length !== 1) return false
  const operation = matches[0]
  return (
    operation.status === 'complete' &&
    operation.authority !== 'foreign' &&
    operation.recordId === record.recordId &&
    operation.operationId === record.operationId &&
    operation.kind === record.kind &&
    operation.record !== null &&
    same(operation.record, record) &&
    equalScope(record, history.source.scope) &&
    operation.parts.every((part) => part.author === history.source.expectedAuthor) &&
    recordIntegrity(operation.parts, record) === null
  )
}

export function negativeFor(history: DecodedHistory, root: Root, entry: Contribution): boolean {
  if (root.payload.purpose !== 'review' || !accounted(history, root) || !accounted(history, entry)) return false
  const payload = entry.payload
  const binding = payload.host.action
  const slot = root.payload.slots.find((candidate) => candidate.slotId === payload.host.slotId)
  return (
    payload.inventoryId === root.recordId &&
    entry.inputs.includes(root.recordId) &&
    slot !== undefined &&
    payload.host.origin === 'native' &&
    payload.host.childId !== null &&
    payload.host.phase === slot.phase &&
    payload.host.role === slot.role &&
    payload.host.chunk === slot.chunk &&
    binding !== undefined &&
    slot.action !== undefined &&
    same(slot.action, binding) &&
    validateActionInputs(binding.inputs).ok &&
    binding.inputs.fingerprint === root.payload.actionInputDigest &&
    binding.inputs.manifest.code.head === root.payload.candidateGitSHA &&
    (!isInitialPullRequestReviewInventory(root.payload) || same(binding.inputs, root.payload.inputSnapshot)) &&
    payload.native?.completion === 'completed' &&
    payload.native.strict === 'valid' &&
    missingContextOutputSchema.safeParse(payload.structured).success &&
    payload.rawAttempts.some((attempt) => same(attempt.data, payload.structured))
  )
}

export function unresolvedStepValid(
  history: DecodedHistory,
  current: Root,
  entry: Contribution,
  contributions: readonly Contribution[],
  records: readonly CanonicalRecord[],
  seen: Set<string>,
): boolean {
  if (
    seen.has(current.recordId) ||
    records.some((record) => record.kind === 'review' && record.payload.inventoryIds.includes(current.recordId))
  )
    return false
  seen.add(current.recordId)
  return (
    contributions.filter((candidate) => negativeFor(history, current, candidate)).length === 1 &&
    contributions.filter(
      (candidate) =>
        candidate.payload.inventoryId === current.recordId &&
        candidate.payload.host.slotId === entry.payload.host.slotId,
    ).length === 1
  )
}

export function successorSlotEntry(
  history: DecodedHistory,
  root: Root,
  contributions: readonly Contribution[],
  slotId: string,
): { next: Contribution; slot: Slot } | undefined {
  const entries = contributions.filter(
    (candidate) => candidate.payload.inventoryId === root.recordId && candidate.payload.host.slotId === slotId,
  )
  const next = entries[0]
  const slot = root.payload.slots.find((candidate) => candidate.slotId === slotId)
  if (entries.length !== 1 || next === undefined || slot === undefined || !accounted(history, next)) return undefined
  return { next, slot }
}

export function resolvedOutputValid(
  next: Contribution,
  slot: Slot,
  rootId: string,
  snapshot: NonNullable<Slot['action']>['inputs'],
): boolean {
  const binding = slot.action
  return (
    next.inputs.includes(rootId) &&
    next.payload.host.origin === 'native' &&
    next.payload.host.childId !== null &&
    next.payload.host.phase === slot.phase &&
    next.payload.host.role === slot.role &&
    next.payload.host.chunk === slot.chunk &&
    binding !== undefined &&
    (next.payload.host.action === undefined || same(binding, next.payload.host.action)) &&
    validateActionInputs(binding.inputs).ok &&
    same(binding.inputs, snapshot) &&
    next.payload.native?.completion === 'completed' &&
    next.payload.native.strict === 'valid' &&
    producerOutputValid(slot.output, next.payload.structured) &&
    next.payload.rawAttempts.some((attempt) => same(attempt.data, next.payload.structured))
  )
}
