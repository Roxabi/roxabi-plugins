import { validateActionInputs } from './action-input.ts'
import type { ActionInputs } from './action-input-schema.ts'
import type { DecodedHistory } from './history-schema.ts'
import { equalScope } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Decision } from './review-schema.ts'
import { reviewSubjectBound } from './review-subject-binding.ts'
import { recordsOf } from './workflow-control.ts'

type ReviewDecision = Extract<Decision, { purpose: 'review' }>
type Inventory = Extract<CanonicalRecord, { kind: 'review-attempt' }>

function initialInventory(records: readonly CanonicalRecord[], inventoryId: string | null): Inventory | null {
  const seen = new Set<string>()
  let current =
    records.find(
      (record): record is Inventory => record.recordId === inventoryId && record.kind === 'review-attempt',
    ) ?? null
  while (current !== null && !seen.has(current.recordId)) {
    seen.add(current.recordId)
    const payload = current.payload
    if (payload.stage === 'initial' && payload.purpose === 'review' && 'inputSnapshot' in payload) return current
    current =
      records.find(
        (record): record is Inventory => record.recordId === payload.rootAttemptId && record.kind === 'review-attempt',
      ) ?? null
  }
  return null
}

export function reviewInputsFromInventory(decision: ReviewDecision, history: DecodedHistory): ActionInputs | null {
  const records = recordsOf(history)
  const sources = records.filter(
    (record): record is Extract<CanonicalRecord, { kind: 'contribution' }> =>
      record.kind === 'contribution' && decision.sourceContributionIds.includes(record.recordId),
  )
  const roots = sources
    .map((source) => initialInventory(records, source.payload.inventoryId))
    .filter((inventory): inventory is Inventory => inventory !== null)
  const distinct = roots.filter(
    (inventory, index) => roots.findIndex((item) => item.recordId === inventory.recordId) === index,
  )
  const selected = distinct.length === 1 ? distinct[0] : null
  if (selected === null || !('inputSnapshot' in selected.payload) || selected.payload.inputSnapshot === null)
    return null
  const snapshot = selected.payload.inputSnapshot
  if (!validateActionInputs(snapshot).ok) return null
  if (selected.payload.actionInputDigest !== snapshot.fingerprint) return null
  return snapshot
}
export function reviewCandidateCode(
  decision: ReviewDecision,
  history: DecodedHistory,
): { repository: string; commit: string } | null {
  const inputs = reviewInputsFromInventory(decision, history)
  if (inputs === null) return null
  const records = recordsOf(history)
  const inventory = records.find(
    (record) =>
      record.kind === 'review-attempt' &&
      'inputSnapshot' in record.payload &&
      record.payload.inputSnapshot?.fingerprint === inputs.fingerprint,
  )
  if (
    inventory?.kind !== 'review-attempt' ||
    inventory.payload.stage !== 'initial' ||
    inventory.payload.purpose !== 'review' ||
    !reviewSubjectBound(inventory, inventory.payload)
  )
    return null
  if (!equalScope(inventory, history.source.scope)) return null
  if (inventory.payload.candidateGitSHA !== inputs.manifest.code.head) return null
  if (inventory.payload.actionInputDigest !== inputs.fingerprint) return null
  return { repository: inputs.manifest.code.repository, commit: inventory.payload.candidateGitSHA }
}
