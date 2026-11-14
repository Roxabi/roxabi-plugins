import { refuseOperationIdentity, refuseUnauthorizedAuthor } from './history-graph-operation.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope, fail, incompatibleFormat, sameRef } from './record-diagnostics.ts'
import { recordIntegrity } from './record-integrity.ts'
import { type ExternalRecordRef, isWorkflowKind } from './record-references.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Diagnostic, Scope } from './record-values.ts'
import type { Result } from './result.ts'

export type MandateRecord = Extract<CanonicalRecord, { kind: 'mandate' }>
export type ControlRecord = Extract<CanonicalRecord, { kind: 'operator-control' }>
export type ReceiptRecord = Extract<CanonicalRecord, { kind: 'action-receipt' }>
export type WorkflowBindingRecord = Extract<CanonicalRecord, { kind: 'workflow-binding' }>
export type SuccessorClaim =
  | { status: 'none' }
  | { status: 'next'; ref: ExternalRecordRef }
  | { status: 'incomplete' | 'conflicting' | 'incompatible-format'; diagnostics: Diagnostic[] }

export const WORKTREE_ACTIONS = new Set<string>([
  'frame',
  'assess-spec',
  'plan',
  'implement',
  'publish',
  'review',
  'fix',
  'attribute-ci',
  'epic-next',
  'epic-final',
  'hook',
  'report',
])

export function refused<T extends string>(
  reason: T,
  evidence: Diagnostic[],
): { status: 'refused'; reason: T; evidence: Diagnostic[] } {
  return { status: 'refused', reason, evidence }
}

export function recordsOf(history: DecodedHistory): CanonicalRecord[] {
  const records: CanonicalRecord[] = []
  const seen = new Set<string>()
  for (const operation of history.operations) {
    if (operation.status !== 'complete' || operation.record === null || operation.authority === 'foreign') continue
    if (seen.has(operation.record.recordId)) continue
    seen.add(operation.record.recordId)
    records.push(operation.record)
  }
  return records
}

function hasIncompatibleFormat(history: DecodedHistory, operation: DecodedHistory['operations'][number]): boolean {
  return history.diagnostics.some(
    (entry) => entry.code === incompatibleFormat && entry.operationId === operation.operationId,
  )
}

function operationProblem(
  history: DecodedHistory,
  operation: DecodedHistory['operations'][number],
): 'ambiguous' | 'incompatible-format' | 'unconfirmed' | null {
  if (operation.authority === 'foreign') return null
  const kind = operation.record?.kind ?? operation.kind
  if (!isWorkflowKind(kind ?? '') && !operation.claimedKinds.some((claim) => isWorkflowKind(claim))) return null
  if (operation.status === 'conflict') return 'ambiguous'
  if (hasIncompatibleFormat(history, operation)) return incompatibleFormat
  if (operation.status === 'incomplete' || operation.status === 'invalid' || operation.status === 'legacy')
    return 'unconfirmed'
  return null
}

export function workflowOperationProblem(
  history: DecodedHistory,
): 'ambiguous' | 'incomplete' | 'incompatible-format' | 'unconfirmed' | null {
  if (!history.source.complete) return 'incomplete'
  for (const operation of history.operations) {
    const problem = operationProblem(history, operation)
    if (problem !== null) return problem
  }
  return null
}

export function bindExternalRef(ref: ExternalRecordRef, foreignHistory: DecodedHistory): Result<CanonicalRecord> {
  if (!equalScope(ref.scope, foreignHistory.source.scope))
    return fail([
      diagnostic('missing-history', `No history was supplied for ${ref.scope.repository} ${ref.scope.target}`),
    ])
  if (!foreignHistory.source.complete)
    return fail([diagnostic('incomplete', 'External history pagination is incomplete')])
  const matchingObservations = foreignHistory.operations.filter(
    (operation) => operation.recordId === ref.recordId || operation.record?.recordId === ref.recordId,
  )
  const matches = matchingObservations.filter((operation) => operation.authority !== 'foreign')
  if (matches.length === 0) {
    if (matchingObservations.length > 0)
      return fail([diagnostic('foreign', `Record ${ref.recordId} is not from the expected author`)])
    return fail([diagnostic('unknown', `Record ${ref.recordId} is not in the foreign history`)])
  }
  if (matches.some((operation) => operation.status === 'conflict'))
    return fail([diagnostic('conflict', `Record ${ref.recordId} has conflicting parts`)])
  if (matches.some((operation) => operation.status !== 'complete' || operation.record === null))
    return fail([diagnostic('unconfirmed', `Record ${ref.recordId} is not a complete authenticated record`)])
  const bodies = matches.map((operation) => JSON.stringify(operation.record))
  if (new Set(bodies).size !== 1)
    return fail([diagnostic('ambiguous', `Record ${ref.recordId} has incompatible duplicates`)])
  const record = matches[0]?.record
  if (record === null || record === undefined)
    return fail([diagnostic('unconfirmed', `Record ${ref.recordId} has no body`)])
  if (record.kind !== ref.kind)
    return fail([diagnostic('kind-mismatch', `Record ${ref.recordId} is ${record.kind}, not ${ref.kind}`)])
  const identity: Diagnostic[] = []
  for (const operation of matches) {
    refuseOperationIdentity(operation, identity)
    refuseUnauthorizedAuthor(operation, foreignHistory, identity)
  }
  if (identity.length > 0) return fail(identity)
  const integrity = matches.flatMap((operation) => {
    if (operation.record === null) return []
    if (operation.parts.some((part) => part.nativeId === null || part.nativeId === '')) {
      return [diagnostic('unconfirmed', `Record ${ref.recordId} has no native part identity`)]
    }
    const checked = recordIntegrity(operation.parts, operation.record)
    return checked === null ? [] : [diagnostic(checked.reason, checked.detail)]
  })
  if (integrity.length > 0) return fail(integrity)
  return { ok: true, value: record }
}

export function historyFor(scope: Scope, histories: readonly DecodedHistory[]): DecodedHistory | null {
  return histories.find((history) => equalScope(history.source.scope, scope)) ?? null
}

/** Exact scoped identity of an action START. Interruption state is never keyed by a bare actionId. */
export function scopedStartKey(ref: { scope: Scope; recordId: string }): string {
  return `${ref.scope.repository}\0${ref.scope.target}\0${ref.recordId}`
}

/** A START maps to itself, a RESULT to the exact START it cites. */
export function receiptStartKey(receipt: ReceiptRecord): string {
  const payload = receipt.payload
  if (payload.phase === 'result') return scopedStartKey(payload.start)
  return scopedStartKey({
    scope: { repository: receipt.repository, target: receipt.target },
    recordId: receipt.recordId,
  })
}

/** Resolved attempts leave progression only; authentication still reads the full history. */
export function excludedReceipt(receipt: ReceiptRecord, excluded: ReadonlySet<string> | undefined): boolean {
  return excluded !== undefined && excluded.size > 0 && excluded.has(receiptStartKey(receipt))
}

export function controlsOf(history: DecodedHistory): ControlRecord[] {
  return recordsOf(history).filter((record): record is ControlRecord => record.kind === 'operator-control')
}

export function mandatesOf(history: DecodedHistory): MandateRecord[] {
  return recordsOf(history).filter((record): record is MandateRecord => record.kind === 'mandate')
}

export function mandateScope(record: MandateRecord): Scope {
  return { repository: record.repository, target: record.target }
}

export function abandoned(history: DecodedHistory, mandate: MandateRecord): boolean {
  const mandateRef = { scope: mandateScope(mandate), recordId: mandate.recordId, kind: 'mandate' as const }
  return controlsOf(history).some(
    (record) => record.payload.control === 'abandon' && sameRef(record.payload.mandate, mandateRef),
  )
}

export function successorOf(history: DecodedHistory, mandate: MandateRecord): ExternalRecordRef | null {
  const mandateRef = { scope: mandateScope(mandate), recordId: mandate.recordId, kind: 'mandate' as const }
  const control = controlsOf(history).find(
    (record) => record.payload.control === 'select-successor' && sameRef(record.payload.predecessor, mandateRef),
  )
  return control?.payload.control === 'select-successor' ? control.payload.successor : null
}

/** Observe one accounted successor claim without choosing a foreign or competing successor. */
export function successorClaim(history: DecodedHistory, mandate: ExternalRecordRef): SuccessorClaim {
  const controls = history.operations.filter(
    (operation) =>
      operation.authority !== 'foreign' &&
      operation.record?.kind === 'operator-control' &&
      operation.record.payload.control === 'select-successor' &&
      sameRef(operation.record.payload.predecessor, mandate),
  )
  if (controls.length === 0) return { status: 'none' }
  if (
    controls.some(
      (operation) =>
        operation.status !== 'complete' || operation.authority !== 'accounted' || operation.record === null,
    )
  ) {
    return {
      status: 'incomplete',
      diagnostics: [diagnostic('unconfirmed', 'A select-successor claim does not confirm an authorized binding chain')],
    }
  }
  const refs = controls.flatMap((operation) =>
    operation.record?.kind === 'operator-control' && operation.record.payload.control === 'select-successor'
      ? [operation.record.payload.successor]
      : [],
  )
  const first = refs[0]
  if (first === undefined || first.kind !== 'mandate' || refs.some((ref) => !sameRef(ref, first))) {
    return {
      status: 'conflicting',
      diagnostics: [diagnostic('conflicting', 'Select-successor controls do not name one mandate')],
    }
  }
  return { status: 'next', ref: first }
}
