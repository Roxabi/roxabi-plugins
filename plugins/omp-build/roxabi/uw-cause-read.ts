import {
  assessCauseDispositions,
  bindExternalRef,
  type GitHubOptions,
  readCauseReports,
  readComposedWorkflowHistory,
  resolveCauseActionInputs,
  resolveOwnSpecEffective,
  validateCauseDispositionRecords,
} from '../dist/contracts.js'
import type { ActionInputs } from '../engine/action-input-schema.ts'
import type { ObservationRef } from '../engine/criterion-evidence-schema.ts'
import type { CauseContext } from '../engine/finding-target.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { ExternalRecordRef } from '../engine/record-references.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import type { UwReadPort } from './uw-contract.ts'

const key = (scope: Scope) => `${scope.repository}\0${scope.target}`
const same = (left: Scope, right: Scope) => key(left) === key(right)
function fail(codes: readonly { code: string }[]): never {
  throw new Error(codes.map((item) => item.code).join(',') || 'cause-source-invalid')
}
async function histories(scopes: readonly Scope[], github: GitHubOptions): Promise<DecodedHistory[]> {
  const unique = [...new Map(scopes.map((scope) => [key(scope), scope])).values()]
  const result = await readComposedWorkflowHistory(unique, github)
  if (!result.ok) {
    if (
      result.histories.some((history) =>
        history.operations.some(
          (operation) =>
            operation.authority !== 'foreign' &&
            operation.status !== 'complete' &&
            (operation.kind === 'cause-operation' || operation.claimedKinds.includes('cause-operation')),
        ),
      )
    )
      throw new Error('cause-creation-incomplete')
    fail(result.diagnostics)
  }
  return result.histories
}
function home(histories: readonly DecodedHistory[], scope: Scope): DecodedHistory {
  const found = histories.find((history) => same(history.source.scope, scope))
  if (!found) throw new Error('cause-history-missing')
  return found
}
function referencedScopes(refs: readonly ObservationRef[]): Scope[] {
  return refs.flatMap((ref) => (ref.source === 'record' ? [ref.record.scope] : []))
}

function addActionScopes(scopes: Scope[], actions: readonly ActionInputs[]): void {
  for (const { manifest } of actions) {
    scopes.push(...manifest.acceptedSources.map((item) => item.record.scope))
    scopes.push(...manifest.deliveryData.map((item) => item.record.scope))
    scopes.push(...referencedScopes(manifest.expandedContext))
    if (manifest.subject.kind === 'uw' && manifest.subject.binding !== null)
      scopes.push(manifest.subject.binding.record.scope)
  }
}

function assertDispositionRebound(ref: ExternalRecordRef, history: DecodedHistory, disposition: CanonicalRecord): void {
  const rebound = bindExternalRef(ref, history)
  if (!rebound.ok || JSON.stringify(rebound.value) !== JSON.stringify(disposition))
    throw new Error('cause-disposition-stale')
}

export type CauseRead = {
  disposition: Extract<CanonicalRecord, { kind: 'cause-disposition' }>
  histories: DecodedHistory[]
  context: CauseContext
}

/** Reconstruct a cause only from its authenticated disposition, original Spec and producer action. */
export async function readAuthenticatedCause(
  ref: ExternalRecordRef & { kind: 'cause-disposition' },
  reader: UwReadPort,
  github: GitHubOptions,
  extraReferences: readonly ObservationRef[] = [],
): Promise<CauseRead> {
  let loaded = await histories([ref.scope], github)
  const bound = bindExternalRef(ref, home(loaded, ref.scope))
  if (!bound.ok) fail(bound.diagnostics)
  if (bound.value.kind !== 'cause-disposition') throw new Error('cause-kind-mismatch')
  const disposition = bound.value
  if (disposition.payload.subject.kind !== 'cause') throw new Error('cause-subject-not-runnable')
  const original = await reader.readUw(ref.scope)
  if (original.accepted.status !== 'accepted') throw new Error('correction-spec-not-accepted')
  const effective = resolveOwnSpecEffective(original.accepted.value)
  if (!effective.ok) fail(effective.diagnostics)
  const context: CauseContext = { original: ref.scope, effective: effective.value }
  const subject = disposition.payload.subject
  const scopes = [ref.scope, subject.decision.scope, effective.value.own.sourceAccepted.scope]
  loaded = await histories(scopes, github)
  const source = bindExternalRef(subject.decision, home(loaded, subject.decision.scope))
  if (!source.ok) fail(source.diagnostics)
  if (source.value.kind !== 'decision') throw new Error('cause-decision-kind-mismatch')
  const inputs = resolveCauseActionInputs({
    decision: source.value,
    history: home(loaded, subject.decision.scope),
    context,
  })
  if (!inputs.ok) fail(inputs.diagnostics)
  addActionScopes(scopes, inputs.value)
  const judgments = subject.cause.judgment
  scopes.push(
    ...referencedScopes([
      ...judgments.necessary.references,
      ...judgments.urgent.references,
      ...judgments.tooLarge.references,
      ...extraReferences,
    ]),
  )
  loaded = await histories(scopes, github)
  const own = home(loaded, ref.scope)
  const records = loaded.flatMap((history) =>
    history.operations.flatMap((operation) =>
      operation.status === 'complete' && operation.authority !== 'foreign' && operation.record !== null
        ? [operation.record]
        : [],
    ),
  )
  const validation = validateCauseDispositionRecords({ records, histories: loaded })
  if (validation.length) fail(validation)
  if (
    records.some(
      (record) =>
        record.kind === 'cause-disposition' &&
        record.payload.previous?.recordId === ref.recordId &&
        same(record.payload.previous.scope, ref.scope),
    )
  )
    throw new Error('cause-disposition-stale')
  const adjudications = records.filter(
    (record): record is Extract<CanonicalRecord, { kind: 'cause-operation' }> =>
      record.kind === 'cause-operation' &&
      same(record, ref.scope) &&
      record.payload.proposal.operation === 'adjudicate-cause',
  )
  const assessed = assessCauseDispositions({
    context,
    source: { kind: 'decision', decision: source.value },
    histories: loaded,
    adjudications,
  })
  if (!assessed.ok) fail(assessed.diagnostics)
  const matching = assessed.value.outcomes.filter(
    (outcome) => JSON.stringify(outcome.subject) === JSON.stringify(disposition.payload.subject),
  )
  if (matching.length !== 1 || JSON.stringify(matching[0]) !== JSON.stringify(disposition.payload))
    throw new Error('cause-disposition-stale')
  assertDispositionRebound(ref, own, disposition)
  return { disposition, histories: loaded, context }
}

/** Promotion uses the immutable original report snapshot, not a PR-wide search. */
export async function readAuthenticatedReport(
  ref: ExternalRecordRef & { kind: 'cause-disposition' },
  github: GitHubOptions,
): Promise<{ record: Extract<CanonicalRecord, { kind: 'cause-disposition' }>; histories: DecodedHistory[] }> {
  const loaded = await histories([ref.scope], github)
  const listing = readCauseReports({ root: ref.scope, subtree: [ref.scope], histories: loaded })
  if (!listing.ok) fail(listing.diagnostics)
  const matches = listing.value.reports.filter(
    (item) => item.ref.recordId === ref.recordId && same(item.ref.scope, ref.scope),
  )
  if (matches.length !== 1 || matches[0] === undefined) throw new Error('report-not-current')
  if (matches[0].promotion !== null) throw new Error('report-already-promoted')
  return { record: matches[0].record, histories: loaded }
}
