import { missingContextOf } from './action-context.ts'
import { canonicalValueDigest } from './action-input.ts'
import { sameInputRef } from './action-input-refs.ts'
import type { ActionInputs } from './action-input-schema.ts'
import { authenticateHistoricalActionInputs } from './historical-action-inputs.ts'
import type { DecodedHistory } from './history-schema.ts'
import { producerOutputValid } from './producer-schema.ts'
import { sameRef } from './record-diagnostics.ts'
import type { ReceiptRecord } from './workflow-control.ts'

export function succeeds(history: DecodedHistory, old: ReceiptRecord, candidate: ReceiptRecord): boolean {
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
  if (oldInputs.fingerprint === newInputs.fingerprint || !authenticateHistoricalActionInputs(newInputs, [history]).ok)
    return false
  if (
    canonicalValueDigest(old.payload.exactInputs) !== canonicalValueDigest(candidate.payload.exactInputs) ||
    canonicalValueDigest(old.payload.mandate) !== canonicalValueDigest(candidate.payload.mandate)
  )
    return false
  return hasNewLineageContext(history, old, oldInputs, newInputs)
}

function hasNewLineageContext(
  history: DecodedHistory,
  old: ReceiptRecord,
  oldInputs: ActionInputs,
  newInputs: ActionInputs,
): boolean {
  const previous = oldInputs.manifest
  const next = newInputs.manifest
  const { expandedContext: oldRefs, ...oldAuthority } = previous
  const { expandedContext: newRefs, ...newAuthority } = next
  if (
    canonicalValueDigest(oldAuthority) !== canonicalValueDigest(newAuthority) ||
    canonicalValueDigest(oldInputs.stageSources) !== canonicalValueDigest(newInputs.stageSources)
  )
    return false
  if (!oldRefs.every((ref) => newRefs.some((nextRef) => sameInputRef(ref, nextRef)))) return false
  const negative = { kind: old.kind, recordId: old.recordId, scope: history.source.scope }
  const lineage = newRefs.filter(
    (ref) =>
      ref.source === 'record' &&
      sameRef(ref.record, negative) &&
      ref.selector === '/payload' &&
      ref.digest === canonicalValueDigest(old.payload),
  )
  if (lineage.length !== 1) return false
  const priorRefs = [
    ...oldRefs,
    ...previous.acceptedSources,
    ...previous.deliveryData,
    ...previous.repositoryReferences,
    ...previous.plugin.files,
    ...oldInputs.stageSources,
  ]
  return newRefs.some(
    (ref) =>
      (ref.source !== 'record' || !sameRef(ref.record, negative)) &&
      !priorRefs.some((oldRef) => sameInputRef(oldRef, ref)),
  )
}
