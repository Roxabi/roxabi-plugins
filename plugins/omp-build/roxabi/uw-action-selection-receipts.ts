import { type MandateRecord, mandateScope, planOutputSchema, recordOperation, recordsOf } from '../dist/contracts.js'
import type { DecodedHistory } from '../engine/history-schema.ts'
import { sameRef } from '../engine/record-diagnostics.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { Result } from '../engine/result.ts'
import type { DeliveryDataRef, UwActionRequest } from './uw-action-contract.ts'
import { actionFailure } from './uw-action-result.ts'
import { refsFor } from './uw-action-selection-refs.ts'
import { cites } from './uw-record-cites.ts'

const OWN_OUTPUT = new Set(['review', 'contribution', 'decision', 'review-attempt'])
export function cycle(records: readonly CanonicalRecord[]): boolean {
  const ids = new Set(records.map((record) => record.recordId))
  const edges = new Map<string, string[]>()
  for (const record of records) {
    const found = new Set<string>()
    cites(record.payload, found)
    found.delete(record.recordId)
    edges.set(
      record.recordId,
      [...found].filter((id) => ids.has(id)),
    )
  }
  const seen = new Set<string>()
  const stack = new Set<string>()
  const visit = (id: string): boolean => {
    if (stack.has(id)) return true
    if (seen.has(id)) return false
    seen.add(id)
    stack.add(id)
    for (const next of edges.get(id) ?? []) if (visit(next)) return true
    stack.delete(id)
    return false
  }
  return [...ids].some((id) => visit(id))
}

function rememberDelivery(item: DeliveryDataRef, seen: Map<string, string>, refs: DeliveryDataRef[]): Result<true> {
  const identity = JSON.stringify([
    item.role,
    item.record.scope.repository,
    item.record.scope.target,
    item.record.kind,
    item.record.recordId,
    item.selector,
  ])
  const prior = seen.get(identity)
  if (prior !== undefined && prior !== item.digest) {
    return actionFailure('action-input-cycle', 'Conflicting delivery declaration at the current head')
  }
  if (prior === undefined) {
    seen.set(identity, item.digest)
    refs.push(item)
  }
  return { ok: true, value: true }
}

function admitReceipt(
  record: CanonicalRecord,
  request: UwActionRequest,
  histories: readonly DecodedHistory[],
  authenticate: (record: CanonicalRecord) => Result<CanonicalRecord>,
  planActionId: string | null,
  mandate: MandateRecord,
): Result<DeliveryDataRef[] | null> {
  if (OWN_OUTPUT.has(record.kind) || record.kind !== 'action-receipt') return { ok: true, value: null }
  const payload = record.payload
  if (payload.action !== 'plan' && payload.action !== 'implement' && payload.action !== 'integrate')
    return { ok: true, value: null }
  const owner = { scope: mandateScope(mandate), kind: 'mandate' as const, recordId: mandate.recordId }
  if (!sameRef(payload.mandate, owner)) return { ok: true, value: null }
  if (
    payload.action === 'plan' &&
    (record.repository !== owner.scope.repository || record.target !== owner.scope.target)
  )
    return { ok: true, value: null }
  if (payload.actionId === request.actionId) return { ok: true, value: null }
  const operation = recordOperation(histories, record)
  if (operation?.authority !== 'accounted') return { ok: true, value: null }
  const authenticated = authenticate(record)
  if (!authenticated.ok) return authenticated
  const selectedRefs = refsFor(record, request.code.head, planActionId, mandate.recordId)
  if (!selectedRefs.ok) return selectedRefs
  if (selectedRefs.value.length === 0) return { ok: true, value: null }
  return { ok: true, value: selectedRefs.value }
}

export function gatherReceipts(
  request: UwActionRequest,
  mandate: MandateRecord,
  histories: readonly DecodedHistory[],
  authenticate: (record: CanonicalRecord) => Result<CanonicalRecord>,
  planActionId: string | null,
): Result<{ refs: DeliveryDataRef[]; selected: CanonicalRecord[] }> {
  const refs: DeliveryDataRef[] = []
  const seen = new Map<string, string>()
  const selected: CanonicalRecord[] = []
  for (const history of histories) {
    const gathered = gatherHistoryReceipts(
      history,
      request,
      mandate,
      histories,
      authenticate,
      planActionId,
      seen,
      refs,
      selected,
    )
    if (!gathered.ok) return gathered
  }
  return { ok: true, value: { refs, selected } }
}

function gatherHistoryReceipts(
  history: DecodedHistory,
  request: UwActionRequest,
  mandate: MandateRecord,
  histories: readonly DecodedHistory[],
  authenticate: (record: CanonicalRecord) => Result<CanonicalRecord>,
  planActionId: string | null,
  seen: Map<string, string>,
  refs: DeliveryDataRef[],
  selected: CanonicalRecord[],
): Result<true> {
  for (const record of recordsOf(history)) {
    const admitted = admitReceipt(record, request, histories, authenticate, planActionId, mandate)
    if (!admitted.ok) return admitted
    if (admitted.value === null) continue
    selected.push(record)
    for (const item of admitted.value) {
      const remembered = rememberDelivery(item, seen, refs)
      if (!remembered.ok) return remembered
    }
  }
  return { ok: true, value: true }
}

export function selectedPlanPaths(gathered: {
  refs: DeliveryDataRef[]
  selected: CanonicalRecord[]
}): Result<string[]> {
  const planRef = gathered.refs.find((ref) => ref.role === 'plan')
  const planRecord = gathered.selected.find(
    (record) =>
      planRef !== undefined &&
      record.recordId === planRef.record.recordId &&
      record.kind === planRef.record.kind &&
      record.repository === planRef.record.scope.repository &&
      record.target === planRef.record.scope.target,
  )
  const plannedPaths: string[] = []
  if (planRef !== undefined) {
    if (
      planRecord?.kind !== 'action-receipt' ||
      planRecord.payload.phase !== 'result' ||
      planRecord.payload.action !== 'plan'
    )
      return actionFailure('record-unreadable', 'Selected plan is absent')
    const plan = planOutputSchema.safeParse(planRecord.payload.structured)
    if (!plan.success) return actionFailure('action-input-missing', 'Current plan result is not a plan')
    plannedPaths.push(...new Set(plan.data.steps.flatMap((step) => step.paths)))
  }
  return { ok: true, value: plannedPaths }
}
