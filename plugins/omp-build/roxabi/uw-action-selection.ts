import {
  abandoned,
  confirmedAccountedMandate,
  historyFor,
  type MandateRecord,
  mandateScope,
  planMacro,
  recordOperation,
  recordsOf,
  successorOf,
} from '../dist/contracts.js'
import type { ActionSpecInput } from '../engine/action-input-schema.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { Result } from '../engine/result.ts'

import type { DeliveryDataRef, UwActionRequest } from './uw-action-contract.ts'
import { expandedPlannerMacro, type PlannerExpansion } from './uw-action-negative-expansion.ts'
import { actionFailure } from './uw-action-result.ts'
import { gatherCorrectionRefs, refsFor } from './uw-action-selection-refs.ts'
import { cites } from './uw-record-cites.ts'

export { assertCurrentOutputClosure, currentRootOutputRefs, knownRoleSelector } from './uw-action-closure.ts'

const OWN_OUTPUT = new Set(['review', 'contribution', 'decision', 'review-attempt'])
const NEEDS_PLAN: Record<string, true> = { implement: true, review: true, 'attribute-ci': true, correction: true }

export function currentAccountedMandate(history: DecodedHistory): Result<MandateRecord> {
  const mandates = recordsOf(history).filter((record): record is MandateRecord => record.kind === 'mandate')
  const confirmed = mandates.filter((mandate) => {
    const ref = { scope: mandateScope(mandate), recordId: mandate.recordId, kind: 'mandate' as const }
    return confirmedAccountedMandate(history, ref) !== null && !abandoned(history, mandate)
  })
  const unique = new Map(confirmed.map((mandate) => [mandate.recordId, mandate]))
  for (const mandate of unique.values()) {
    const next = successorOf(history, mandate)
    if (next !== null && !unique.has(next.recordId)) {
      return actionFailure('record-unreadable', 'Mandate successor is not a confirmed accounted record')
    }
  }
  const open = [...unique.values()].filter((mandate) => successorOf(history, mandate) === null)
  if (open.length === 0) return actionFailure('action-input-missing', 'No current accounted mandate')
  if (open.length > 1) return actionFailure('action-input-cycle', 'Several accounted mandates have no successor')
  const mandate = open[0]
  return mandate === undefined
    ? actionFailure('action-input-missing', 'No current accounted mandate')
    : { ok: true, value: mandate }
}

function cycle(records: readonly CanonicalRecord[]): boolean {
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
  const identity = `${item.role}\0${item.selector}\0${item.digest}`
  const prior = seen.get(`${item.role}\0${item.record.recordId}\0${item.selector}`)
  if (prior !== undefined && prior !== item.digest) {
    return actionFailure('action-input-cycle', 'Conflicting delivery declaration at the current head')
  }
  if (prior === undefined) {
    seen.set(`${item.role}\0${item.record.recordId}\0${item.selector}`, item.digest)
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
  mandateId: string,
): Result<DeliveryDataRef[] | null> {
  if (OWN_OUTPUT.has(record.kind) || record.kind !== 'action-receipt') return { ok: true, value: null }
  const payload = record.payload as { actionId?: unknown }
  if (payload.actionId === request.actionId) return { ok: true, value: null }
  const operation = recordOperation(histories, record)
  if (operation?.authority !== 'accounted') return { ok: true, value: null }
  const authenticated = authenticate(record)
  if (!authenticated.ok) return authenticated
  const selectedRefs = refsFor(record, request.code.head, planActionId, mandateId)
  if (!selectedRefs.ok) return selectedRefs
  if (selectedRefs.value.length === 0) return { ok: true, value: null }
  return { ok: true, value: selectedRefs.value }
}

function gatherReceipts(
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
    const admitted = admitReceipt(record, request, histories, authenticate, planActionId, mandate.recordId)
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

export function selectDeliveryData(
  request: UwActionRequest,
  mandate: MandateRecord,
  histories: readonly DecodedHistory[],
  authenticate: (record: CanonicalRecord) => Result<CanonicalRecord>,
  expansion?: PlannerExpansion,
  spec?: ActionSpecInput,
): Result<DeliveryDataRef[]> {
  const issue = historyFor(mandateScope(mandate), histories)
  if (issue === null) return actionFailure('record-unreadable', 'Mandate history is absent')
  const pullRequest = request.subject.kind === 'uw' ? request.subject.pullRequest : null
  const evidence = { issue, pullRequest: pullRequest === null ? null : historyFor(pullRequest, histories), parents: [] }
  const selected =
    expansion === undefined
      ? { ok: true as const, value: planMacro(evidence, mandate) }
      : expandedPlannerMacro(evidence, mandate, expansion)
  if (!selected.ok) return selected
  const macro = selected.value
  if (macro.phase === 'uncertain' || macro.phase === 'blocked') return { ok: false, diagnostics: macro.evidence }
  const planActionId = macro.amendmentActionId ?? macro.draftActionId
  if (NEEDS_PLAN[request.purpose] && (macro.phase !== 'eligible' || planActionId === null)) {
    return actionFailure('action-input-missing', 'No current eligible plan')
  }
  const gathered = gatherReceipts(request, mandate, histories, authenticate, planActionId)
  if (!gathered.ok) return gathered
  const corrections = gatherCorrectionRefs(
    request,
    mandate,
    histories,
    authenticate,
    planActionId,
    spec,
    gathered.value,
  )
  if (!corrections.ok) return corrections
  if (cycle(gathered.value.selected)) return actionFailure('action-input-cycle', 'Delivery references cycle')
  return { ok: true, value: gathered.value.refs }
}
