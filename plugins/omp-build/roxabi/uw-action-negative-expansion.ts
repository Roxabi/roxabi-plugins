import {
  bindExternalRef,
  canonicalValueDigest,
  historyFor,
  type MandateRecord,
  mandateScope,
  missingContextOutputSchema,
  outstandingPauseRequest,
  planMacro,
  recordOperation,
  recordsOf,
  unliftedPause,
  validateActionInputs,
  workflowContextResolution,
  workflowOperationProblem,
} from '../dist/contracts.js'
import type { ActionInputs } from '../engine/action-input-schema.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { Result } from '../engine/result.ts'
import type { PlanMacro, WorkflowEvidence } from '../engine/workflow-plan.ts'
import type { UwActionRequest } from './uw-action-contract.ts'
import { authenticate } from './uw-action-observe.ts'
import { matchesReviewedDraft, plannerLineage } from './uw-action-planner-lineage.ts'
import { actionFailure } from './uw-action-result.ts'
import { matchesRequestedSubject } from './uw-action-subject.ts'

const equal = (left: unknown, right: unknown): boolean => canonicalValueDigest(left) === canonicalValueDigest(right)

function contextIdentity(
  ref: ActionInputs['manifest']['expandedContext'][number] | ActionInputs['manifest']['deliveryData'][number],
): string {
  if (ref.source === 'git-file') return canonicalValueDigest(ref)
  return canonicalValueDigest({ source: ref.source, record: ref.record, selector: ref.selector, digest: ref.digest })
}

type Receipt = Extract<CanonicalRecord, { kind: 'action-receipt' }>
type PlanResult = Receipt & {
  payload: Extract<Receipt['payload'], { action: 'plan' | 'plan-review'; phase: 'result' }>
}
type PlannerSlot =
  | { action: 'plan'; exact: Extract<PlanResult['payload'], { action: 'plan' }>['exactInputs'] }
  | { action: 'plan-review'; exact: Extract<PlanResult['payload'], { action: 'plan-review' }>['exactInputs'] }
export type PlannerExpansion = {
  histories: readonly DecodedHistory[]
  leaf: Receipt
  previous: ActionInputs
  mandate: PlanResult['payload']['mandate']
  slot: PlannerSlot
}

function plannerCandidates(request: UwActionRequest, records: readonly CanonicalRecord[]): Result<PlanResult[]> {
  const candidates: PlanResult[] = []
  for (const ref of request.expandedContext) {
    if (ref.source !== 'record' || ref.record.kind !== 'action-receipt' || ref.selector !== '/payload') continue
    const found = records.filter(
      (record) =>
        record.kind === 'action-receipt' &&
        record.recordId === ref.record.recordId &&
        record.repository === ref.record.scope.repository &&
        record.target === ref.record.scope.target,
    )
    if (found.length !== 1) continue
    const record = found[0]
    if (
      record?.kind !== 'action-receipt' ||
      record.payload.phase !== 'result' ||
      record.payload.action !== request.purpose
    )
      continue
    if (!missingContextOutputSchema.safeParse(record.payload.structured).success) continue
    if (canonicalValueDigest(record.payload) !== ref.digest)
      return actionFailure('review-input-changed', 'Negative receipt digest changed')
    candidates.push(record as PlanResult)
  }
  return { ok: true, value: candidates }
}

function previousPlannerInputs(
  request: UwActionRequest,
  start: Receipt,
  body: PlanResult['payload'],
): Result<ActionInputs> {
  if (body.action !== 'plan-review') return { ok: true, value: body.inputs }
  const matching = body.contributions.filter(
    (item) =>
      item.host.origin === 'native' &&
      item.native?.completion === 'completed' &&
      item.native.strict === 'valid' &&
      item.host.action !== undefined &&
      equal(item.structured, body.structured) &&
      item.host.slotId !== null &&
      body.slots.some(
        (slot) =>
          slot.slotId === item.host.slotId &&
          slot.specialist === item.host.role &&
          slot.action !== undefined &&
          equal(slot.action, item.host.action),
      ),
  )
  const binding = matching[0]?.host.action
  if (
    start.payload.action !== 'plan-review' ||
    !equal(start.payload.slots, body.slots) ||
    matching.length !== 1 ||
    binding === undefined ||
    body.slots.some((slot) => slot.action?.actionId === request.actionId) ||
    !validateActionInputs(binding.inputs).ok
  )
    return actionFailure('record-unreadable', 'Negative plan review does not match a unique authenticated host slot')
  return { ok: true, value: binding.inputs }
}

function validatePlannerExpansionRefs(
  request: UwActionRequest,
  previous: ActionInputs,
  result: PlanResult,
): Result<true> {
  if (
    previous.manifest.purpose !== request.purpose ||
    !equal(previous.manifest.code, request.code) ||
    !matchesRequestedSubject(previous.manifest.subject, request.subject) ||
    !equal(previous.stageSources, request.stageSources)
  )
    return actionFailure(
      'review-input-changed',
      'Expanded planner request changes its original authority or stage sources',
    )
  const requested = new Set(request.expandedContext.map(canonicalValueDigest))
  if (previous.manifest.expandedContext.some((ref) => !requested.has(canonicalValueDigest(ref))))
    return actionFailure('review-input-changed', 'Expanded planner request omits prior context')
  const prior = new Set(
    [
      ...previous.manifest.expandedContext,
      ...previous.manifest.acceptedSources,
      ...previous.manifest.deliveryData,
      ...previous.manifest.repositoryReferences,
      ...previous.stageSources,
    ].map(contextIdentity),
  )
  const negativeRef = request.expandedContext.find(
    (ref) => ref.source === 'record' && ref.record.recordId === result.recordId && ref.selector === '/payload',
  )
  if (
    negativeRef === undefined ||
    !request.expandedContext.some((ref) => !prior.has(contextIdentity(ref)) && !equal(ref, negativeRef))
  )
    return actionFailure('action-input-missing', 'Expanded planner request needs additional pinned context')
  return { ok: true, value: true }
}

function matchedPlannerStart(
  request: UwActionRequest,
  result: PlanResult,
  records: readonly CanonicalRecord[],
  histories: readonly DecodedHistory[],
): Result<Receipt> {
  const body = result.payload
  if (
    body.actionId === request.actionId ||
    body.native.completion !== 'completed' ||
    body.native.strict !== 'valid' ||
    body.admission !== null
  )
    return actionFailure('record-unreadable', 'Negative planner result is not a fresh authenticated terminal')
  const operation = recordOperation(histories, result)
  if (operation?.authority !== 'accounted' || !authenticate(result, histories).ok)
    return actionFailure('record-unreadable', 'Negative planner result is not accounted and authenticated')
  const resultHistory = historyFor({ repository: result.repository, target: result.target }, histories)
  const startHistory = historyFor(body.start.scope, histories)
  if (
    resultHistory === null ||
    startHistory === null ||
    !bindExternalRef({ scope: resultHistory.source.scope, kind: result.kind, recordId: result.recordId }, resultHistory)
      .ok ||
    !bindExternalRef(body.start, startHistory).ok
  )
    return actionFailure('record-unreadable', 'Negative planner pair is not bound to complete authenticated history')
  const starts = records.filter(
    (record) =>
      record.kind === 'action-receipt' &&
      record.payload.phase === 'start' &&
      record.recordId === body.start.recordId &&
      record.kind === body.start.kind &&
      record.repository === body.start.scope.repository &&
      record.target === body.start.scope.target,
  )
  const start = starts[0]
  if (
    starts.length !== 1 ||
    start?.kind !== 'action-receipt' ||
    start.payload.phase !== 'start' ||
    start.payload.action !== body.action ||
    start.payload.actionId !== body.actionId ||
    !equal(start.payload.exactInputs, body.exactInputs) ||
    !equal(start.payload.mandate, body.mandate) ||
    !equal(start.payload.inputs, body.inputs) ||
    recordOperation(histories, start)?.authority !== 'accounted' ||
    !authenticate(start, histories).ok ||
    !validateActionInputs(body.inputs).ok
  )
    return actionFailure('record-unreadable', 'Negative planner result does not match its accounted start')
  return { ok: true, value: start }
}

/** The only record removed from planner evaluation is the exact authenticated pair named by the request. */
export function plannerExpansion(
  request: UwActionRequest,
  histories: readonly DecodedHistory[],
): Result<PlannerExpansion | null> {
  if (request.purpose !== 'plan' && request.purpose !== 'plan-review') return { ok: true, value: null }
  const records = histories.flatMap(recordsOf)
  const selected = plannerCandidates(request, records)
  if (!selected.ok) return selected
  const candidates = selected.value.filter((result) => {
    const scope = { repository: result.repository, target: result.target }
    const history = historyFor(scope, histories)
    return (
      history === null ||
      recordOperation(histories, result)?.authority !== 'accounted' ||
      !authenticate(result, histories).ok ||
      !bindExternalRef({ scope, kind: result.kind, recordId: result.recordId }, history).ok ||
      workflowContextResolution(history, result) !== 'clear'
    )
  })
  if (candidates.length === 0) return { ok: true, value: null }
  const lineage = plannerLineage(candidates, histories)
  if (!lineage.ok) return lineage
  if (histories.some((history) => workflowOperationProblem(history) !== null))
    return actionFailure('record-unreadable', 'Expansion history is incomplete or uncertain')
  if (records.some((record) => record.kind === 'action-receipt' && record.payload.actionId === request.actionId))
    return actionFailure('action-input-cycle', 'Expanded action id is already in use')
  const result = lineage.value.leaf
  const body = result.payload
  const matched = matchedPlannerStart(request, result, records, histories)
  if (!matched.ok) return matched
  const start = matched.value
  const original = previousPlannerInputs(request, start, body)
  if (!original.ok) return original
  const previous = original.value
  const references = validatePlannerExpansionRefs(request, previous, result)
  if (!references.ok) return references
  const slot: PlannerSlot =
    body.action === 'plan'
      ? { action: 'plan', exact: body.exactInputs }
      : { action: 'plan-review', exact: body.exactInputs }
  return { ok: true, value: { histories, leaf: result, previous, slot, mandate: body.mandate } }
}

export function expandedPlannerMacro(
  evidence: WorkflowEvidence,
  mandate: MandateRecord,
  expansion: PlannerExpansion,
): Result<PlanMacro> {
  if (outstandingPauseRequest(evidence.issue, mandate) !== null || unliftedPause(evidence.issue, mandate) !== null)
    return actionFailure('action-input-missing', 'Planner authority has an outstanding or active pause')
  const blocked = planMacro(evidence, mandate)
  if (
    blocked.phase !== 'blocked' ||
    blocked.evidence.length === 0 ||
    blocked.evidence.some((item) => item.code !== 'action-context-missing')
  )
    return actionFailure('action-input-missing', 'The selected negative is not the only planner block')
  const issue = historyFor(mandateScope(mandate), expansion.histories)
  if (issue === null) return actionFailure('record-unreadable', 'Expanded planner history is absent')
  const macro = planMacro({ ...evidence, issue }, mandate, { contextLeaf: expansion.leaf })
  const { slot } = expansion
  const exact = slot.exact
  if (exact.mandateId !== mandate.recordId || exact.specDigest !== macro.specDigest)
    return actionFailure('review-input-changed', 'Expanded planner request changes mandate or Spec')
  if (slot.action === 'plan') {
    if (
      slot.exact.amendsReviewActionId === null
        ? macro.phase !== 'needs-draft'
        : macro.phase !== 'needs-amendment' ||
          macro.reviewActionId !== slot.exact.amendsReviewActionId ||
          canonicalValueDigest(macro.blockers) !== canonicalValueDigest(slot.exact.requiredBlockers)
    )
      return actionFailure('review-input-changed', 'Expanded planner request changes its semantic slot')
  } else if (!matchesReviewedDraft(issue, macro, slot)) {
    return actionFailure('review-input-changed', 'Expanded plan review changes its reviewed draft')
  }
  return { ok: true, value: macro }
}
