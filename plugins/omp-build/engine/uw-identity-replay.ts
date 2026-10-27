import type { DecodedHistory } from './history-schema.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { Scope } from './record-values.ts'
import type { UwDiagnostic } from './uw-diagnostics.ts'
import { nextCriterionId, nextInvariantId, nextSpecItemId } from './uw-identity-allocation.ts'
import { type SpecIdentityPayload, specIdentityPayloadSchema } from './uw-identity-schema.ts'
import type { SpecItemId } from './uw-spec.ts'

export type SpecIdentityReplay = {
  allocations: Map<SpecItemId, ExternalRecordRef>
  retired: Map<SpecItemId, ExternalRecordRef>
  head: ExternalRecordRef | null
  nextCriterion: string
  nextInvariant: string
}

function diagnostic(uw: Scope, code: string, message: string): UwDiagnostic {
  return { code, message, location: { kind: 'native', uw, connection: 'state' }, related: [] }
}

function same(left: ExternalRecordRef | null, right: ExternalRecordRef | null): boolean {
  return left === null || right === null
    ? left === right
    : left.recordId === right.recordId &&
        left.kind === right.kind &&
        left.scope.repository === right.scope.repository &&
        left.scope.target === right.scope.target
}

function record(
  operation: DecodedHistory['operations'][number],
): { ref: ExternalRecordRef; payload: SpecIdentityPayload } | null {
  if (
    operation.status !== 'complete' ||
    operation.record === null ||
    operation.authority === 'foreign' ||
    operation.record.kind !== 'spec-identity'
  )
    return null
  const payload = specIdentityPayloadSchema.safeParse(operation.record.payload)
  return payload.success
    ? {
        ref: {
          scope: { repository: operation.record.repository, target: operation.record.target },
          recordId: operation.record.recordId,
          kind: 'spec-identity',
        },
        payload: payload.data,
      }
    : null
}

function applyAllocations(
  replay: SpecIdentityReplay,
  allocations: Extract<SpecIdentityPayload, { event: 'allocate' }>['allocations'],
  ref: ExternalRecordRef,
  uw: Scope,
  diagnostics: UwDiagnostic[],
): void {
  for (const allocation of allocations) {
    const required = allocation.id.startsWith('C')
      ? nextCriterionId(replay.nextCriterion)
      : nextInvariantId(replay.nextInvariant)
    if (replay.allocations.has(allocation.id) || allocation.id !== required) {
      diagnostics.push(diagnostic(uw, 'spec-ledger-conflict', `Invalid allocation ${allocation.id}`))
      continue
    }
    replay.allocations.set(allocation.id, ref)
    if (allocation.id.startsWith('C')) replay.nextCriterion = nextSpecItemId(allocation.id)
    else replay.nextInvariant = nextSpecItemId(allocation.id)
  }
}

function applyProposedRetirements(
  replay: SpecIdentityReplay,
  ids: Extract<SpecIdentityPayload, { event: 'retire-proposed' }>['ids'],
  ref: ExternalRecordRef,
  uw: Scope,
  diagnostics: UwDiagnostic[],
): void {
  for (const id of ids) {
    if (!replay.allocations.has(id) || replay.retired.has(id))
      diagnostics.push(diagnostic(uw, 'spec-ledger-conflict', `Invalid retirement ${id}`))
    else replay.retired.set(id, ref)
  }
}

function applyIdentityRecord(
  replay: SpecIdentityReplay,
  entry: { ref: ExternalRecordRef; payload: SpecIdentityPayload },
  uw: Scope,
  diagnostics: UwDiagnostic[],
): void {
  if (!same(entry.payload.predecessor, replay.head)) {
    diagnostics.push(diagnostic(uw, 'spec-ledger-conflict', 'Identity ledger fork or predecessor mismatch'))
    return
  }
  if (entry.payload.event === 'allocate')
    applyAllocations(replay, entry.payload.allocations, entry.ref, uw, diagnostics)
  else applyProposedRetirements(replay, entry.payload.ids, entry.ref, uw, diagnostics)
  replay.head = entry.ref
}

/** Replays only complete local or accounted identity records; foreign observations cannot poison the local ledger. */
export function replaySpecIdentityHistory(
  history: DecodedHistory,
  uw: Scope,
  diagnostics: UwDiagnostic[],
): SpecIdentityReplay {
  const replay: SpecIdentityReplay = {
    allocations: new Map(),
    retired: new Map(),
    head: null,
    nextCriterion: '1',
    nextInvariant: '1',
  }
  for (const operation of history.operations) {
    if (
      operation.authority === 'foreign' ||
      (operation.kind !== 'spec-identity' && !operation.claimedKinds.includes('spec-identity'))
    )
      continue
    const entry = record(operation)
    if (entry === null)
      diagnostics.push(diagnostic(uw, 'spec-ledger-incomplete', 'Identity record is incomplete or unauthenticated'))
    else applyIdentityRecord(replay, entry, uw, diagnostics)
  }
  return replay
}
