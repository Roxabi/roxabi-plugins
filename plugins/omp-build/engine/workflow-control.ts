import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope, fail, sameRef } from './record-diagnostics.ts'
import { type ExternalRecordRef, isWorkflowKind } from './record-references.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Diagnostic, Scope } from './record-values.ts'
import type { Result } from './result.ts'

export type MandateRecord = Extract<CanonicalRecord, { kind: 'mandate' }>
export type ControlRecord = Extract<CanonicalRecord, { kind: 'operator-control' }>
export type ReceiptRecord = Extract<CanonicalRecord, { kind: 'action-receipt' }>
export type WorkflowBindingRecord = Extract<CanonicalRecord, { kind: 'workflow-binding' }>

export type PauseBinding = {
  mandate: ExternalRecordRef
  confirmation: ExternalRecordRef
}

export const WORKTREE_ACTIONS = new Set<string>([
  'frame',
  'assess-spec',
  'plan',
  'implement',
  'publish',
  'proof',
  'review',
  'fix',
  'attribute-ci',
  'epic-next',
  'epic-final',
  'mark-fix',
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

export function workflowOperationProblem(history: DecodedHistory): 'ambiguous' | 'incomplete' | 'unconfirmed' | null {
  if (!history.source.complete) return 'incomplete'
  for (const operation of history.operations) {
    const kind = operation.record?.kind ?? operation.kind
    if (!isWorkflowKind(kind ?? '') && !operation.claimedKinds.some((claim) => isWorkflowKind(claim))) continue
    if (operation.status === 'conflict') return 'ambiguous'
    if (operation.status === 'incomplete' || operation.status === 'invalid' || operation.status === 'legacy')
      return 'unconfirmed'
    if (operation.authority === 'foreign') return 'unconfirmed'
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
  const matches = foreignHistory.operations.filter(
    (operation) => operation.recordId === ref.recordId || operation.record?.recordId === ref.recordId,
  )
  if (matches.length === 0) return fail([diagnostic('unknown', `Record ${ref.recordId} is not in the foreign history`)])
  if (matches.some((operation) => operation.status === 'conflict'))
    return fail([diagnostic('conflict', `Record ${ref.recordId} has conflicting parts`)])
  if (matches.some((operation) => operation.status !== 'complete' || operation.record === null))
    return fail([diagnostic('unconfirmed', `Record ${ref.recordId} is not a complete authenticated record`)])
  if (matches.some((operation) => operation.authority === 'foreign'))
    return fail([diagnostic('foreign', `Record ${ref.recordId} is not from the expected author`)])
  const bodies = matches.map((operation) => JSON.stringify(operation.record))
  if (new Set(bodies).size !== 1)
    return fail([diagnostic('ambiguous', `Record ${ref.recordId} has incompatible duplicates`)])
  const record = matches[0]?.record
  if (record === null || record === undefined)
    return fail([diagnostic('unconfirmed', `Record ${ref.recordId} has no body`)])
  if (record.kind !== ref.kind)
    return fail([diagnostic('kind-mismatch', `Record ${ref.recordId} is ${record.kind}, not ${ref.kind}`)])
  return { ok: true, value: record }
}

export function historyFor(scope: Scope, histories: readonly DecodedHistory[]): DecodedHistory | null {
  return histories.find((history) => equalScope(history.source.scope, scope)) ?? null
}

export function controlsOf(history: DecodedHistory): ControlRecord[] {
  return recordsOf(history).filter((record): record is ControlRecord => record.kind === 'operator-control')
}

export function mandatesOf(history: DecodedHistory): MandateRecord[] {
  return recordsOf(history).filter((record): record is MandateRecord => record.kind === 'mandate')
}

function pauseRequestFor(mandate: MandateRecord, record: ControlRecord): boolean {
  return (
    record.payload.control === 'pause-requested' &&
    sameRef(record.payload.mandate, { scope: mandateScope(mandate), recordId: mandate.recordId, kind: 'mandate' })
  )
}

function pauseConfirmationFor(
  history: DecodedHistory,
  mandate: MandateRecord,
  request: ControlRecord,
): ControlRecord | null {
  const requestRef: ExternalRecordRef = {
    scope: { repository: request.repository, target: request.target },
    recordId: request.recordId,
    kind: 'operator-control',
  }
  return (
    controlsOf(history).find(
      (record) =>
        record.payload.control === 'pause-confirmed' &&
        record.payload.controlId === request.payload.controlId &&
        sameRef(record.payload.mandate, {
          scope: mandateScope(mandate),
          recordId: mandate.recordId,
          kind: 'mandate',
        }) &&
        record.payload.predecessor !== null &&
        sameRef(record.payload.predecessor, requestRef) &&
        record.payload.disarm.observed === true,
    ) ?? null
  )
}

export function confirmedPause(history: DecodedHistory, mandate: MandateRecord): ControlRecord | null {
  for (const request of controlsOf(history)) {
    if (!pauseRequestFor(mandate, request)) continue
    const confirmation = pauseConfirmationFor(history, mandate, request)
    if (confirmation !== null) return confirmation
  }
  return null
}

export function unliftedPause(history: DecodedHistory, mandate: MandateRecord): ControlRecord | null {
  for (const request of controlsOf(history)) {
    if (!pauseRequestFor(mandate, request)) continue
    const confirmation = pauseConfirmationFor(history, mandate, request)
    if (confirmation !== null && !pauseLifted(history, confirmation)) return confirmation
  }
  return null
}

export function outstandingPauseRequest(history: DecodedHistory, mandate: MandateRecord): ControlRecord | null {
  return (
    controlsOf(history).find(
      (record) => pauseRequestFor(mandate, record) && pauseConfirmationFor(history, mandate, record) === null,
    ) ?? null
  )
}

export function outstandingPauseInAuthority(
  mandate: MandateRecord,
  histories: readonly DecodedHistory[],
  seen: ReadonlySet<string> = new Set(),
): Diagnostic | null {
  const scope = mandateScope(mandate)
  const key = `${scope.repository}\0${scope.target}\0${mandate.recordId}`
  if (seen.has(key)) return null
  const home = historyFor(scope, histories)
  if (home === null) return null
  if (outstandingPauseRequest(home, mandate) !== null)
    return diagnostic('pause-unconfirmed', `Mandate ${mandate.recordId} has an unconfirmed pause request`)
  if (mandate.payload.parent === null) return null
  const parentHistory = historyFor(mandate.payload.parent.scope, histories)
  if (parentHistory === null) return null
  const parent = bindExternalRef(mandate.payload.parent, parentHistory)
  if (!parent.ok || parent.value.kind !== 'mandate') return null
  const nextSeen = new Set(seen)
  nextSeen.add(key)
  return outstandingPauseInAuthority(parent.value, histories, nextSeen)
}

function pauseLifted(history: DecodedHistory, confirmation: ControlRecord): boolean {
  if (confirmation.payload.control !== 'pause-confirmed') return false
  return controlsOf(history).some(
    (record) =>
      record.payload.control === 'resume' &&
      record.payload.controlId === confirmation.payload.controlId &&
      sameRef(record.payload.mandate, confirmation.payload.mandate) &&
      sameRef(record.payload.predecessor, {
        scope: { repository: confirmation.repository, target: confirmation.target },
        recordId: confirmation.recordId,
        kind: 'operator-control',
      }),
  )
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

export function epicFixScopes(histories: readonly DecodedHistory[], run: string): Scope[] {
  const scopes: Scope[] = []
  for (const history of histories) {
    for (const record of recordsOf(history)) {
      if (record.kind !== 'epic-event' || record.runId !== run) continue
      if (typeof record.payload !== 'object' || record.payload === null || Array.isArray(record.payload)) continue
      if (Reflect.get(record.payload, 'event') !== 'epic-fix') continue
      scopes.push({ repository: record.repository, target: record.target })
    }
  }
  return scopes
}

export function childPermitted(
  parent: MandateRecord,
  childScope: Scope,
  histories: readonly DecodedHistory[],
): boolean {
  if (parent.payload.role !== 'epic') return false
  if (parent.payload.children.some((child) => equalScope(child.scope, childScope))) return true
  return epicFixScopes(histories, parent.payload.run).some((scope) => equalScope(scope, childScope))
}
