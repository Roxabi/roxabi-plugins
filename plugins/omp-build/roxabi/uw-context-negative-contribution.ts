import {
  canonicalValueDigest,
  missingContextOutputSchema,
  recordsOf,
  workflowOperationProblem,
} from '../dist/contracts.js'
import type { ActionInputs, RecordInputRef } from '../engine/action-input-schema.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { Slot } from '../engine/record-values.ts'
import type { Result } from '../engine/result.ts'
import type { UwActionRequest } from './uw-action-contract.ts'
import { actionFailure } from './uw-action-result.ts'
import { matchesRequestedSubject } from './uw-action-subject.ts'
import {
  accounted,
  contextIdentity,
  equal,
  laterReviewBaseline,
  matchesNativeSlot,
  sameScope,
} from './uw-context-review-successor.ts'

type Contribution = Extract<CanonicalRecord, { kind: 'contribution' }>
type Inventory = Extract<CanonicalRecord, { kind: 'review-attempt' }>

export type NegativeContributionOrigin = {
  previous: ActionInputs
  negativeRef: RecordInputRef
  rootAttemptId: string
  actionId: string
  inventoryId: string
  slot: Slot
} & ({ inherited: true; currentRootAttemptId: string } | { inherited?: false; currentRootAttemptId?: never })

type Candidate = { record: Contribution; ref: RecordInputRef }
type AuthenticatedCandidate = {
  inventory: Inventory
  root: Inventory
  slot: Slot
  binding: NonNullable<Contribution['payload']['host']['action']>
}

/** Resolve only an explicitly cited, conserved native negative; never infer one from a partial record. */
export function resolveNegativeContribution(
  request: UwActionRequest,
  histories: readonly DecodedHistory[],
): Result<NegativeContributionOrigin | null> {
  if (request.purpose !== 'review' && request.purpose !== 'correction') return { ok: true, value: null }
  const records = histories.flatMap(recordsOf)
  const candidates = findCandidates(request, records)
  if (!candidates.ok) return candidates
  if (candidates.value.length === 0) return { ok: true, value: null }
  if (histories.some((history) => workflowOperationProblem(history) !== null))
    return actionFailure('record-unreadable', 'Expansion history is incomplete or uncertain')
  return selectCandidate(request, records, histories, candidates.value)
}

function findCandidates(request: UwActionRequest, records: readonly CanonicalRecord[]): Result<Candidate[]> {
  const candidates: Candidate[] = []
  for (const ref of request.expandedContext) {
    if (ref.source !== 'record' || ref.record.kind !== 'contribution' || ref.selector !== '/payload') continue
    const found = records.filter(
      (record): record is Contribution =>
        record.kind === 'contribution' &&
        record.recordId === ref.record.recordId &&
        sameScope(record, ref.record.scope),
    )
    if (found.length > 1 && found.some((item) => missingContextOutputSchema.safeParse(item.payload.structured).success))
      return actionFailure('record-unreadable', 'Negative contribution is not uniquely identifiable')
    if (found.length !== 1 || !missingContextOutputSchema.safeParse(found[0]?.payload.structured).success) continue
    const record = found[0]
    if (record === undefined) continue
    if (ref.digest !== canonicalValueDigest(record.payload))
      return actionFailure('review-input-changed', 'Negative contribution digest changed')
    candidates.push({ record, ref })
  }
  return { ok: true, value: candidates }
}

function selectCandidate(
  request: UwActionRequest,
  records: readonly CanonicalRecord[],
  histories: readonly DecodedHistory[],
  candidates: readonly Candidate[],
): Result<NegativeContributionOrigin | null> {
  const fresh: NegativeContributionOrigin[] = []
  const inherited: NegativeContributionOrigin[] = []
  for (const candidate of candidates) {
    const resolved = resolveCandidate(request, records, histories, candidate)
    if (!resolved.ok) return resolved
    if (resolved.value === null) continue
    if (resolved.value.inherited === true) inherited.push(resolved.value)
    else fresh.push(resolved.value)
  }
  if (fresh.length > 1)
    return actionFailure('action-input-cycle', 'Expansion names multiple unresolved negative contributions')
  if (fresh.length === 1) return { ok: true, value: fresh[0] ?? null }
  if (inherited.some((entry) => entry.currentRootAttemptId !== inherited[0]?.currentRootAttemptId))
    return actionFailure('action-input-cycle', 'Inherited negatives have competing current roots')
  return { ok: true, value: inherited[0] ?? null }
}

function authenticateCandidate(
  request: UwActionRequest,
  records: readonly CanonicalRecord[],
  histories: readonly DecodedHistory[],
  record: Contribution,
): Result<AuthenticatedCandidate | null> {
  const body = record.payload
  const binding = body.host.action
  const inventories = records.filter(
    (item): item is Inventory =>
      item.kind === 'review-attempt' && item.recordId === body.inventoryId && sameScope(item, record),
  )
  const inventory = inventories[0]
  if (
    inventories.length !== 1 ||
    inventory === undefined ||
    !accounted(record, histories) ||
    !accounted(inventory, histories)
  )
    return actionFailure(
      'record-unreadable',
      'Negative contribution or inventory is not uniquely accounted and authenticated',
    )
  if (inventory.payload.purpose !== request.purpose) return { ok: true, value: null }
  const roots = records.filter(
    (item): item is Inventory =>
      item.kind === 'review-attempt' && item.recordId === inventory.payload.rootAttemptId && sameScope(item, inventory),
  )
  const root = roots[0]
  if (
    roots.length !== 1 ||
    root === undefined ||
    root.payload.stage !== 'initial' ||
    root.payload.rootAttemptId !== root.recordId ||
    root.payload.purpose !== inventory.payload.purpose ||
    !accounted(root, histories)
  )
    return actionFailure('record-unreadable', 'Negative contribution has no authenticated matching root')
  return authenticateSlot(records, record, inventory, root, binding)
}

function authenticateSlot(
  records: readonly CanonicalRecord[],
  record: Contribution,
  inventory: Inventory,
  root: Inventory,
  binding: Contribution['payload']['host']['action'],
): Result<AuthenticatedCandidate> {
  const slots = inventory.payload.slots.filter((slot) => slot.slotId === record.payload.host.slotId)
  const slot = slots[0]
  const peers = records.filter(
    (item) =>
      item.kind === 'contribution' &&
      sameScope(item, record) &&
      item.payload.inventoryId === inventory.recordId &&
      item.payload.host.slotId === record.payload.host.slotId,
  )
  if (
    slots.length !== 1 ||
    slot === undefined ||
    peers.length !== 1 ||
    binding === undefined ||
    !matchesNativeSlot(record, inventory, slot, binding)
  )
    return actionFailure(
      'record-unreadable',
      'Negative contribution does not match its unique native host slot and input digest',
    )
  if (
    root.payload.purpose === 'review' &&
    root.payload.stage === 'initial' &&
    inventory.recordId === root.recordId &&
    !equal(root.payload.inputSnapshot, binding.inputs)
  )
    return actionFailure('record-unreadable', 'Negative review action does not match its inventory snapshot')
  return { ok: true, value: { inventory, root, slot, binding } }
}

function resolveCandidate(
  request: UwActionRequest,
  records: readonly CanonicalRecord[],
  histories: readonly DecodedHistory[],
  candidate: Candidate,
): Result<NegativeContributionOrigin | null> {
  const authenticated = authenticateCandidate(request, records, histories, candidate.record)
  if (!authenticated.ok) return authenticated
  if (authenticated.value === null) return { ok: true, value: null }
  const { inventory, root, slot, binding } = authenticated.value
  const { ref } = candidate
  const later =
    inventory.recordId === root.recordId
      ? laterReviewBaseline(request, records, histories, root, slot, binding.inputs, ref)
      : { ok: true as const, value: null }
  if (!later.ok) return later
  if (later.value !== null && !later.value.current) return { ok: true, value: null }
  if (later.value !== null)
    return {
      ok: true,
      value: {
        previous: later.value.inputs,
        negativeRef: ref,
        rootAttemptId: root.recordId,
        actionId: binding.actionId,
        inventoryId: inventory.recordId,
        slot,
        inherited: true,
        currentRootAttemptId: later.value.rootAttemptId,
      },
    }
  return freshOrigin(request, records, ref, authenticated.value)
}

function freshOrigin(
  request: UwActionRequest,
  records: readonly CanonicalRecord[],
  ref: RecordInputRef,
  { inventory, root, slot, binding }: AuthenticatedCandidate,
): Result<NegativeContributionOrigin> {
  const previous = binding.inputs
  if (
    binding.actionId === request.actionId ||
    records.some(
      (item) =>
        item.kind === 'review-attempt' &&
        item.payload.slots.some((entry) => entry.action?.actionId === request.actionId),
    )
  )
    return actionFailure('action-input-cycle', 'Expanded action id is already in use')
  if (
    previous.manifest.purpose !== request.purpose ||
    !matchesRequestedSubject(previous.manifest.subject, request.subject) ||
    !equal(previous.manifest.code, request.code) ||
    !equal(previous.stageSources, request.stageSources)
  )
    return actionFailure('review-input-changed', 'Expanded request changes original action authority or stage sources')
  const requested = new Set(request.expandedContext.map(canonicalValueDigest))
  if (previous.manifest.expandedContext.some((item) => !requested.has(canonicalValueDigest(item))))
    return actionFailure('review-input-changed', 'Expanded request omits prior context')
  const prior = new Set(
    [
      ...previous.manifest.expandedContext,
      ...previous.manifest.acceptedSources,
      ...previous.manifest.deliveryData,
      ...previous.manifest.repositoryReferences,
      ...previous.stageSources,
    ].map(contextIdentity),
  )
  if (!request.expandedContext.some((item) => !prior.has(contextIdentity(item)) && !equal(item, ref)))
    return actionFailure('action-input-missing', 'Expanded request needs additional pinned context')
  return {
    ok: true,
    value: {
      previous,
      negativeRef: ref,
      rootAttemptId: root.recordId,
      actionId: binding.actionId,
      inventoryId: inventory.recordId,
      slot,
      inherited: false,
    },
  }
}
