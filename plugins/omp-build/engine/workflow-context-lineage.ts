import { missingContextOf } from './action-context.ts'
import { canonicalValueDigest, validateActionInputs } from './action-input.ts'
import type { ActionInputs } from './action-input-schema.ts'
import type { DecodedHistory } from './history-schema.ts'
import { producerOutputValid } from './producer-schema.ts'
import { equalScope } from './record-diagnostics.ts'
import type { ReceiptRecord } from './workflow-control.ts'

export function succeeds(
  history: DecodedHistory,
  old: ReceiptRecord,
  candidate: ReceiptRecord,
  replayStart = false,
): boolean {
  if (
    old.payload.phase !== 'result' ||
    (candidate.payload.phase !== 'result' &&
      !(replayStart && candidate.payload.phase === 'start' && candidate.payload.action === 'assess-spec')) ||
    old.payload.action !== candidate.payload.action ||
    old.payload.actionId === candidate.payload.actionId
  )
    return false
  let oldInputs = old.payload.inputs
  let newInputs = candidate.payload.inputs
  if (
    old.payload.action === 'plan-review' &&
    candidate.payload.action === 'plan-review' &&
    candidate.payload.phase === 'result'
  ) {
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
