import { validateActionInputs } from './action-input.ts'
import type { ActionInputs } from './action-input-schema.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope, fail } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Result } from './result.ts'
import type { Decision } from './review-schema.ts'
import { reviewSubjectBound } from './review-subject-binding.ts'
import { bindExternalRef, recordsOf } from './workflow-control.ts'

type ReviewDecision = Extract<Decision, { purpose: 'review' }>
type Inventory = Extract<CanonicalRecord, { kind: 'review-attempt' }>

function initialInventory(
  records: readonly CanonicalRecord[],
  inventoryId: string | null,
  history: DecodedHistory,
): Inventory | null {
  const seen = new Set<string>()
  let current =
    records.find(
      (record): record is Inventory => record.recordId === inventoryId && record.kind === 'review-attempt',
    ) ?? null
  while (current !== null && !seen.has(current.recordId)) {
    seen.add(current.recordId)
    const authenticated = bindExternalRef(
      { scope: history.source.scope, kind: 'review-attempt', recordId: current.recordId },
      history,
    )
    if (!authenticated.ok) return null
    const payload = current.payload
    if (payload.stage === 'initial' && payload.purpose === 'review' && payload.rootAttemptId === current.recordId)
      return current
    current =
      records.find(
        (record): record is Inventory => record.recordId === payload.rootAttemptId && record.kind === 'review-attempt',
      ) ?? null
  }
  return null
}

function selectedInventory(decision: ReviewDecision, history: DecodedHistory): Inventory | null {
  const records = recordsOf(history)
  const sources = records.filter(
    (record): record is Extract<CanonicalRecord, { kind: 'contribution' }> =>
      record.kind === 'contribution' && decision.sourceContributionIds.includes(record.recordId),
  )
  if (sources.length !== decision.sourceContributionIds.length) return null
  for (const source of sources) {
    if (!bindExternalRef({ scope: history.source.scope, kind: 'contribution', recordId: source.recordId }, history).ok)
      return null
  }
  const roots = sources
    .map((source) => initialInventory(records, source.payload.inventoryId, history))
    .filter((inventory): inventory is Inventory => inventory !== null)
  if (roots.length !== sources.length) return null
  const distinct = roots.filter(
    (inventory, index) => roots.findIndex((item) => item.recordId === inventory.recordId) === index,
  )
  const selected = distinct.length === 1 ? distinct[0] : null
  if (selected === null || selected.payload.stage !== 'initial' || selected.payload.purpose !== 'review') return null
  const snapshot = selected.payload.inputSnapshot
  if (!validateActionInputs(snapshot).ok || selected.payload.actionInputDigest !== snapshot.fingerprint) return null
  if (!reviewSubjectBound(selected, selected.payload) || !equalScope(selected, history.source.scope)) return null
  if (selected.payload.candidateGitSHA !== snapshot.manifest.code.head) return null
  return selected
}

export function reviewInputsFromInventory(decision: ReviewDecision, history: DecodedHistory): ActionInputs | null {
  const root = selectedInventory(decision, history)
  if (root === null || root.payload.stage !== 'initial' || root.payload.purpose !== 'review') return null
  return root.payload.inputSnapshot
}

export function reviewRootFromDecision(
  decision: Extract<CanonicalRecord, { kind: 'decision' }>,
  history: DecodedHistory,
): Result<Inventory> {
  const scope = history.source.scope
  const bound = bindExternalRef({ scope, kind: 'decision', recordId: decision.recordId }, history)
  if (!bound.ok) return bound
  if (JSON.stringify(bound.value) !== JSON.stringify(decision) || decision.payload.judgment.purpose !== 'review')
    return fail([diagnostic('unconfirmed', 'Selected review decision is not authenticated')])
  const root = selectedInventory(decision.payload.judgment, history)
  if (root === null) return fail([diagnostic('unconfirmed', 'Selected review has no unique initial inventory')])
  const rootBound = bindExternalRef({ scope, kind: 'review-attempt', recordId: root.recordId }, history)
  if (!rootBound.ok) return rootBound
  if (rootBound.value.kind !== 'review-attempt')
    return fail([diagnostic('kind-mismatch', 'Selected review root is not an inventory')])
  return { ok: true, value: rootBound.value }
}
export function reviewCandidateCode(
  decision: ReviewDecision,
  history: DecodedHistory,
): { repository: string; commit: string } | null {
  const inventory = selectedInventory(decision, history)
  if (inventory === null || inventory.payload.stage !== 'initial' || inventory.payload.purpose !== 'review') return null
  return {
    repository: inventory.payload.inputSnapshot.manifest.code.repository,
    commit: inventory.payload.candidateGitSHA,
  }
}
