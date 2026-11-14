import {
  canonicalValueDigest,
  deliveryMissingContextSchema,
  excludedReceipt,
  historyFor,
  missingContextOutputSchema,
  outstandingPauseRequest,
  recordsOf,
  resolutionIndex,
  unliftedPause,
  workflowContextDirectSuccessor,
  workflowContextResolution,
  workflowContextTerminal,
} from '../dist/contracts.js'
import type { ActionInputs } from '../engine/action-input-schema.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { Result } from '../engine/result.ts'
import type { UwActionRequest } from './uw-action-contract.ts'
import { actionFailure } from './uw-action-result.ts'
import { currentAccountedMandate } from './uw-action-selection.ts'
import { matchesRequestedSubject } from './uw-action-subject.ts'
import { validateExpansionHistory } from './uw-context-negative-history.ts'
import {
  authenticateNegative,
  authenticateStart,
  type Family,
  type Negative,
  type Receipt,
} from './uw-context-negative-receipt.ts'

const equal = (a: unknown, b: unknown) => canonicalValueDigest(a) === canonicalValueDigest(b)
export type NonPlanExpansion = {
  previous: ActionInputs
  histories: readonly DecodedHistory[]
  mandate: Negative['payload']['mandate']
  slot: { action: Family; exact: unknown }
}

function negativeOutput(result: Negative): boolean {
  if (result.payload.action === 'implement') {
    return deliveryMissingContextSchema.safeParse(result.payload.structured).success
  }
  return missingContextOutputSchema.safeParse(result.payload.structured).success
}

function contextIdentity(
  ref: ActionInputs['manifest']['expandedContext'][number] | ActionInputs['manifest']['deliveryData'][number],
): string {
  return ref.source === 'git-file'
    ? canonicalValueDigest(ref)
    : canonicalValueDigest({ source: ref.source, record: ref.record, selector: ref.selector, digest: ref.digest })
}

function candidateForRef(
  ref: UwActionRequest['expandedContext'][number],
  purpose: UwActionRequest['purpose'],
  records: readonly CanonicalRecord[],
): Result<Negative | null> {
  if (ref.source !== 'record' || ref.record.kind !== 'action-receipt' || ref.selector !== '/payload')
    return { ok: true, value: null }
  const found = records.filter(
    (record) =>
      record.kind === 'action-receipt' &&
      record.recordId === ref.record.recordId &&
      record.repository === ref.record.scope.repository &&
      record.target === ref.record.scope.target,
  )
  const record = found[0]
  if (
    found.length !== 1 ||
    record?.kind !== 'action-receipt' ||
    record.payload.phase !== 'result' ||
    record.payload.action !== purpose
  )
    return { ok: true, value: null }
  const negative = record as Negative
  if (!negativeOutput(negative)) return { ok: true, value: null }
  if (canonicalValueDigest(record.payload) !== ref.digest)
    return actionFailure('review-input-changed', 'Negative receipt digest changed')
  return { ok: true, value: negative }
}

function outstandingCandidate(
  result: Negative,
  request: UwActionRequest,
  histories: readonly DecodedHistory[],
  excluded: ReadonlySet<string>,
): Result<boolean> {
  const terminal = authenticateNegative(result, request, histories)
  if (!terminal.ok) return terminal
  const start = authenticateStart(result, histories)
  if (!start.ok) return start
  const history = historyFor({ repository: result.repository, target: result.target }, histories)
  if (history === null) return actionFailure('record-unreadable', 'Negative result history is absent')
  const state = workflowContextResolution(history, result, excluded)
  if (state === 'clear') return { ok: true, value: false }
  if (state !== 'missing')
    return actionFailure('action-input-missing', 'Selected negative lineage is not uniquely resolved')
  const direct = workflowContextDirectSuccessor(history, result, excluded)
  if (direct.status === 'successor') return { ok: true, value: false }
  if (direct.status !== 'missing')
    return actionFailure('action-input-missing', 'Selected negative lineage is not uniquely resolved')
  return { ok: true, value: true }
}

function selectNegative(
  request: UwActionRequest,
  histories: readonly DecodedHistory[],
  excluded: ReadonlySet<string>,
): Result<Negative | null> {
  const records = histories.flatMap(recordsOf)
  const candidates: Negative[] = []
  for (const ref of request.expandedContext) {
    const candidate = candidateForRef(ref, request.purpose, records)
    if (!candidate.ok) return candidate
    if (candidate.value === null) continue
    const outstanding = outstandingCandidate(candidate.value, request, histories, excluded)
    if (!outstanding.ok) return outstanding
    if (outstanding.value) candidates.push(candidate.value)
  }
  if (candidates.length === 0) return { ok: true, value: null }
  if (candidates.length !== 1)
    return actionFailure('action-input-cycle', 'Expansion names multiple negative workflow results')
  const validated = validateExpansionHistory(request, histories, records)
  if (!validated.ok) return validated
  const result = candidates[0]
  return result === undefined
    ? actionFailure('record-unreadable', 'Negative result is absent')
    : { ok: true, value: result }
}

function validateExpansionRequest(result: Negative, request: UwActionRequest): Result<true> {
  const body = result.payload
  const previous = body.inputs
  if (
    previous.manifest.purpose !== request.purpose ||
    !equal(previous.manifest.code, request.code) ||
    !matchesRequestedSubject(previous.manifest.subject, request.subject) ||
    !equal(previous.stageSources, request.stageSources)
  )
    return actionFailure('review-input-changed', 'Expanded request changes its original authority or stage sources')
  const requested = new Set(request.expandedContext.map(canonicalValueDigest))
  if (previous.manifest.expandedContext.some((ref) => !requested.has(canonicalValueDigest(ref))))
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
  const negativeRef = request.expandedContext.find(
    (ref) => ref.source === 'record' && ref.record.recordId === result.recordId && ref.selector === '/payload',
  )
  if (
    negativeRef === undefined ||
    !request.expandedContext.some((ref) => !prior.has(contextIdentity(ref)) && !equal(ref, negativeRef))
  )
    return actionFailure('action-input-missing', 'Expanded request needs additional pinned context')
  return { ok: true, value: true }
}

function validateRemaining(
  histories: readonly DecodedHistory[],
  result: Negative,
  excluded: ReadonlySet<string>,
): Result<true> {
  if (
    histories.some((history) =>
      ['frame', 'plan', 'plan-review', 'assess-spec', 'attribute-ci', 'implement'].some(
        (action) => workflowContextTerminal(history, action, result, excluded) !== 'clear',
      ),
    )
  )
    return actionFailure('action-input-missing', 'Another context block or uncertain successor remains')
  const remaining = histories
    .flatMap(recordsOf)
    .filter(
      (record): record is Receipt =>
        record.kind === 'action-receipt' &&
        record.payload.action === result.payload.action &&
        !excludedReceipt(record, excluded),
    )
  if (
    remaining.some(
      (record) =>
        record.payload.phase === 'start' &&
        !remaining.some(
          (other) => other.payload.phase === 'result' && other.payload.actionId === record.payload.actionId,
        ),
    )
  )
    return actionFailure('action-input-missing', 'Another action start remains unresolved')
  return { ok: true, value: true }
}

function validateCurrentMandate(
  result: Negative,
  request: UwActionRequest,
  histories: readonly DecodedHistory[],
): Result<true> {
  const body = result.payload
  if (request.subject.kind !== 'uw')
    return actionFailure('action-input-missing', 'Workflow expansion requires a UW subject')
  const issue = historyFor(request.subject.uw, histories)
  if (issue === null) return actionFailure('record-unreadable', 'Workflow UW history is absent')
  const current = currentAccountedMandate(issue)
  if (!current.ok && current.diagnostics.some((diagnostic) => diagnostic.code !== 'action-input-missing'))
    return actionFailure('record-unreadable', 'Current workflow mandate is unresolved')
  if (
    body.mandate.kind === 'mandate' &&
    (!current.ok ||
      current.value.recordId !== body.mandate.recordId ||
      !equal({ repository: current.value.repository, target: current.value.target }, body.mandate.scope))
  )
    return actionFailure('review-input-changed', 'Workflow mandate is no longer current')
  if (
    current.ok &&
    (outstandingPauseRequest(issue, current.value) !== null || unliftedPause(issue, current.value) !== null)
  )
    return actionFailure('action-input-missing', 'Workflow authority has an outstanding or active pause')
  return { ok: true, value: true }
}

/** Resolve only a complete authenticated negative and its exact original start. */
export function nonPlanExpansion(
  request: UwActionRequest,
  histories: readonly DecodedHistory[],
): Result<NonPlanExpansion | null> {
  if (!['frame', 'assess-spec', 'attribute-ci', 'implement'].includes(request.purpose)) return { ok: true, value: null }
  const index = resolutionIndex(histories)
  if (!index.ok) return actionFailure('action-input-missing', 'Interruption resolution is invalid')
  const excluded = new Set(index.value.resolved.keys())
  const selected = selectNegative(request, histories, excluded)
  if (!selected.ok) return selected
  if (selected.value === null) return { ok: true, value: null }
  const result = selected.value
  const expanded = validateExpansionRequest(result, request)
  if (!expanded.ok) return expanded
  const remaining = validateRemaining(histories, result, excluded)
  if (!remaining.ok) return remaining
  const mandate = validateCurrentMandate(result, request, histories)
  if (!mandate.ok) return mandate
  return {
    ok: true,
    value: {
      previous: result.payload.inputs,
      histories,
      mandate: result.payload.mandate,
      slot: { action: result.payload.action, exact: result.payload.exactInputs },
    },
  }
}
