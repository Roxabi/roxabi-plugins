import {
  accounted,
  canonicalValueDigest,
  historyFor,
  missingContextOf,
  recordsOf,
  resolvedOutputValid,
  workflowOperationProblem,
} from '../dist/contracts.js'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { Result } from '../engine/result.ts'
import type { ReviewClassCatalogues } from '../engine/review-class-catalogue.ts'
import type { RecordInputRef, UwActionRequest } from './uw-action-contract.ts'
import { matchesRequestedSubject } from './uw-action-subject.ts'
import { priorCorrectionDecision } from './uw-correction-stage-decision.ts'

type Contribution = Extract<CanonicalRecord, { kind: 'contribution' }>
type Inventory = Extract<CanonicalRecord, { kind: 'review-attempt' }>

function validSlot(entry: Contribution, inventory: Inventory, request: UwActionRequest): boolean {
  const slots = inventory.payload.slots.filter((slot) => slot.slotId === entry.payload.host.slotId)
  const slot = slots[0]
  if (slots.length !== 1 || slot === undefined || slot.action === undefined) return false
  const binding = slot.action
  if (
    binding.actionId === request.actionId ||
    binding.inputs.manifest.purpose !== 'correction' ||
    binding.inputs.fingerprint !== inventory.payload.actionInputDigest ||
    binding.inputs.manifest.code.head !== inventory.payload.candidateGitSHA
  )
    return false
  return (
    missingContextOf(entry.payload.structured) === null &&
    resolvedOutputValid(entry, slot, inventory.recordId, binding.inputs)
  )
}

function anchoredDecision(
  entry: Contribution,
  inventory: Inventory,
  request: UwActionRequest,
  histories: readonly DecodedHistory[],
  catalogues: ReviewClassCatalogues,
): Result<boolean> {
  const slot = inventory.payload.slots.find((item) => item.slotId === entry.payload.host.slotId)
  const binding = slot?.action
  if (binding === undefined || !matchesRequestedSubject(binding.inputs.manifest.subject, request.subject))
    return { ok: true, value: false }
  for (const decision of request.stageSources) {
    if (
      decision.record.kind !== 'decision' ||
      !inventory.inputs.includes(decision.record.recordId) ||
      !binding.inputs.stageSources.some((source) => canonicalValueDigest(source) === canonicalValueDigest(decision))
    )
      continue
    const result = priorCorrectionDecision(decision, request, histories, catalogues)
    if (!result.ok || result.value) return result
  }
  return { ok: true, value: false }
}

/** Authenticated prior correction output is stage data, never dispatch authority. */
export function priorCorrectionContribution(
  ref: RecordInputRef,
  request: UwActionRequest,
  histories: readonly DecodedHistory[],
  catalogues: ReviewClassCatalogues,
): Result<boolean> {
  if (request.purpose !== 'correction' || ref.record.kind !== 'contribution' || ref.selector !== '/payload')
    return { ok: true, value: false }
  const scope = request.subject.pullRequest
  if (
    scope === null ||
    scope.repository !== ref.record.scope.repository ||
    scope.target !== ref.record.scope.target ||
    request.code.repository !== scope.repository
  )
    return { ok: true, value: false }
  const history = historyFor(scope, histories)
  if (history === null || workflowOperationProblem(history) !== null) return { ok: true, value: false }
  const records = recordsOf(history)
  const entries = records.filter(
    (record): record is Contribution => record.kind === 'contribution' && record.recordId === ref.record.recordId,
  )
  const entry = entries[0]
  if (
    entries.length !== 1 ||
    entry === undefined ||
    canonicalValueDigest(entry.payload) !== ref.digest ||
    !accounted(history, entry) ||
    entry.payload.inventoryId === null
  )
    return { ok: true, value: false }
  const inventories = records.filter(
    (record): record is Inventory => record.kind === 'review-attempt' && record.recordId === entry.payload.inventoryId,
  )
  const inventory = inventories[0]
  if (
    inventories.length !== 1 ||
    inventory === undefined ||
    inventory.payload.purpose !== 'correction' ||
    !entry.inputs.includes(inventory.recordId) ||
    !accounted(history, inventory)
  )
    return { ok: true, value: false }
  const peers = records.filter(
    (record) =>
      record.kind === 'contribution' &&
      record.payload.inventoryId === inventory.recordId &&
      record.payload.host.slotId === entry.payload.host.slotId,
  )
  if (peers.length !== 1 || !validSlot(entry, inventory, request)) return { ok: true, value: false }
  return anchoredDecision(entry, inventory, request, histories, catalogues)
}
