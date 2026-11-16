import { canonicalValueDigest } from './action-input.ts'
import { hasAuthenticatedOrdinaryFixTerminal } from './fix-owner-terminal.ts'
import type { FixRecoveryProposal } from './fix-recovery-control-schema.ts'
import { inspectRecoveryHistoricalFacts } from './fix-recovery-historical-facts.ts'
import { linkAuthenticatedRecoveryOwners, type RecoveryOwnerLineage } from './fix-recovery-owner-lineage.ts'
import { commentAsPartPin, partPinsEqual } from './fix-recovery-part-pins.ts'
import { fixRecoveryProposalFromControl } from './fix-recovery-proposal.ts'
import { inspectProspectiveControls } from './fix-recovery-prospective-controls.ts'
import type { OpenedRef, RecoveryRef } from './fix-recovery-schema.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope, sameRef } from './record-diagnostics.ts'
import { recordIntegrity } from './record-integrity.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Scope } from './record-values.ts'
import type { Result } from './result.ts'
import { bindExternalRef } from './workflow-control.ts'

type CloseProposal = Extract<FixRecoveryProposal, { phase: 'close-publication' | 'close-predecision' }>
type Control = Extract<CanonicalRecord, { kind: 'fix-recovery' }>
export type ReplayedFixRecoveryClose = Readonly<{ control: Control; proposal: CloseProposal; digest: string }>
export type ReplayedFixRecoveryControl = Readonly<{ control: Control; proposal: FixRecoveryProposal; digest: string }>
const fail = (message: string): Result<never> => ({ ok: false, diagnostics: [diagnostic('unconfirmed', message)] })
type Operation = DecodedHistory['operations'][number]
function partsAuthenticated(operation: Operation, history: DecodedHistory): boolean {
  return !operation.parts.some((part) => {
    const pin = commentAsPartPin(part)
    return (
      pin === null ||
      history.source.comments.filter((comment) => {
        const actual = commentAsPartPin(comment)
        return actual !== null && partPinsEqual(pin, actual)
      }).length !== 1
    )
  })
}
function authenticateOwner(
  record: CanonicalRecord,
  operation: Operation,
  history: DecodedHistory,
  uw: Scope,
): Result<Extract<CanonicalRecord, { kind: 'fix-owner' }>> {
  if (record.kind !== 'fix-owner' || !equalScope(record, uw)) return fail('Owner lineage has an incompatible claim')
  if (record.payload.phase === 'opened') {
    const common = record.payload.common
    if (
      common.host.admission.destinationDigest !==
      canonicalValueDigest([
        common.destination.authority,
        common.destination.publicationRepository,
        common.destination.destinationRef,
      ])
    )
      return fail('Owner admission descriptor does not bind its destination')
  }
  const same = history.operations.filter(
    (entry) =>
      entry.authority !== 'foreign' && (entry.recordId === record.recordId || entry.operationId === record.operationId),
  )
  const bound = bindExternalRef({ scope: uw, kind: 'fix-owner', recordId: record.recordId }, history)
  if (
    same.length !== 1 ||
    !bound.ok ||
    canonicalValueDigest(bound.value) !== canonicalValueDigest(record) ||
    !partsAuthenticated(operation, history)
  )
    return fail('Owner lineage has an unauthenticated opening or settlement')
  return { ok: true, value: record }
}

type LineageRecords = { owners: Extract<CanonicalRecord, { kind: 'fix-owner' }>[]; controls: Control[] }
function collectOperationLineage(
  operation: Operation,
  history: DecodedHistory,
  histories: readonly DecodedHistory[],
  uw: Scope,
  seen: ReadonlySet<string>,
  records: LineageRecords,
): Result<void> {
  if (operation.authority === 'foreign') return { ok: true, value: undefined }
  const ownerClaim =
    equalScope(history.source.scope, uw) &&
    (operation.kind === 'fix-owner' || operation.claimedKinds.includes('fix-owner'))
  const controlClaim = operation.kind === 'fix-recovery' || operation.claimedKinds.includes('fix-recovery')
  if (!ownerClaim && !controlClaim) return { ok: true, value: undefined }
  if (
    operation.status !== 'complete' ||
    operation.record === null ||
    recordIntegrity(operation.parts, operation.record) !== null
  )
    return fail('Owner lineage has an incomplete or changed claim')
  const record = operation.record
  if (ownerClaim) {
    const owner = authenticateOwner(record, operation, history, uw)
    if (!owner.ok) return owner
    records.owners.push(owner.value)
  } else if (record.kind === 'fix-recovery' && equalScope(record.payload.uw, uw)) {
    const replay = replayCloseInternal({ control: record, histories }, seen)
    if (!replay.ok) return replay
    records.controls.push(record)
  }
  return { ok: true, value: undefined }
}
function collectHistoryLineage(
  history: DecodedHistory,
  histories: readonly DecodedHistory[],
  uw: Scope,
  seen: ReadonlySet<string>,
  records: LineageRecords,
): Result<void> {
  for (const operation of history.operations) {
    const result = collectOperationLineage(operation, history, histories, uw, seen, records)
    if (!result.ok) return result
  }
  return { ok: true, value: undefined }
}
export function authenticatedLineage(
  histories: readonly DecodedHistory[],
  uw: Scope,
  seen: ReadonlySet<string>,
): Result<RecoveryOwnerLineage> {
  const records: LineageRecords = { owners: [], controls: [] }
  for (const history of histories) {
    const result = collectHistoryLineage(history, histories, uw, seen, records)
    if (!result.ok) return result
  }
  return linkAuthenticatedRecoveryOwners(records.owners, records.controls, (owner) =>
    hasAuthenticatedOrdinaryFixTerminal(owner, histories),
  )
}

export function unclosedLineage(histories: readonly DecodedHistory[], uw: Scope, seen: ReadonlySet<string>) {
  const lineage = authenticatedLineage(histories, uw, seen)
  if (!lineage.ok) return lineage
  const links = lineage.value.links
  const last = links.at(-1)
  if (last === undefined || last.settlement === null || last.control !== null)
    return fail('No uniquely settled unclosed recovery owner')
  const previous = links.at(-2)?.control ?? null
  return {
    ok: true as const,
    value: {
      opened: {
        kind: 'fix-owner' as const,
        scope: { repository: last.opening.repository, target: last.opening.target },
        recordId: last.opening.recordId,
      },
      predecessor:
        previous === null
          ? null
          : {
              kind: 'fix-recovery' as const,
              scope: { repository: previous.repository, target: previous.target },
              recordId: previous.recordId,
            },
    },
  }
}

/** Internal lineage fact selection, never an execution grant. */
export function selectUnclosedRecoveryOwner(histories: readonly DecodedHistory[], uw: Scope) {
  return unclosedLineage(histories, uw, new Set())
}
function matchesLineage(
  lineage: Result<{ opened: OpenedRef; predecessor: RecoveryRef | null }>,
  proposal: FixRecoveryProposal,
): boolean {
  if (!lineage.ok || !sameRef(lineage.value.opened, proposal.opened)) return false
  const previous = lineage.value.predecessor
  return previous === null
    ? proposal.predecessor === null
    : proposal.predecessor !== null && sameRef(previous, proposal.predecessor)
}

/** Validate a confirmed candidate against real prior anchors without pretending it has been read back. */
export function validateProspectiveFixRecoveryControl(input: {
  control: Control
  histories: readonly DecodedHistory[]
}): Result<FixRecoveryProposal> {
  const reconstructed = fixRecoveryProposalFromControl(input.control)
  if (!reconstructed.ok) return reconstructed
  const proposal = reconstructed.value
  const facts = inspectRecoveryHistoricalFacts(proposal, input.histories)
  if (!facts.ok) return facts
  const lineage = unclosedLineage(facts.value.histories, proposal.uw, new Set())
  if (!matchesLineage(lineage, proposal))
    return fail('Recovery predecessor does not match the authenticated owner lineage')
  const inspected = inspectProspectiveControls(input, proposal)
  if (!inspected.ok) return inspected
  return { ok: true, value: proposal }
}

/** Historical membership only; never a live continuation grant. */
export function replayFixRecoveryClose(input: {
  control: Control
  histories: readonly DecodedHistory[]
}): Result<ReplayedFixRecoveryClose> {
  const replayed = replayCloseInternal(input, new Set())
  if (!replayed.ok) return replayed
  return replayed.value.proposal.phase === 'adopt-decision'
    ? fail('Decision adoption is not a close control')
    : { ok: true, value: { ...replayed.value, proposal: replayed.value.proposal } }
}

export function replayFixRecoveryControl(input: {
  control: Control
  histories: readonly DecodedHistory[]
}): Result<ReplayedFixRecoveryControl> {
  return replayCloseInternal(input, new Set())
}
function authenticatePublication(record: Control, history: DecodedHistory): Result<Operation> {
  const bound = bindExternalRef(
    {
      kind: 'fix-recovery',
      scope: { repository: record.repository, target: record.target },
      recordId: record.recordId,
    },
    history,
  )
  if (!bound.ok || canonicalValueDigest(bound.value) !== canonicalValueDigest(record))
    return fail('Recovery control author or identity is not authenticated')
  const matches = history.operations.filter(
    (operation) => operation.recordId === record.recordId || operation.operationId === record.operationId,
  )
  const operation = matches[0]
  if (
    matches.length !== 1 ||
    operation === undefined ||
    operation.status !== 'complete' ||
    operation.authority === 'foreign' ||
    operation.record?.kind !== 'fix-recovery' ||
    canonicalValueDigest(operation.record) !== canonicalValueDigest(record) ||
    recordIntegrity(operation.parts, record) !== null ||
    !partsAuthenticated(operation, history)
  )
    return fail('Recovery control is not one immutable authenticated raw publication')
  return { ok: true, value: operation }
}

function uniqueCompetitor(
  histories: readonly DecodedHistory[],
  proposal: FixRecoveryProposal,
  operation: Operation,
): boolean {
  const competitors = histories
    .flatMap((entry) => entry.operations)
    .filter(
      (entry) =>
        entry.authority !== 'foreign' &&
        entry.record?.kind === 'fix-recovery' &&
        sameRef(entry.record.payload.opened, proposal.opened),
    )
  return competitors.length === 1 && competitors[0] === operation
}

export function replayCloseInternal(
  input: { control: Control; histories: readonly DecodedHistory[] },
  seen: ReadonlySet<string>,
): Result<ReplayedFixRecoveryControl> {
  const record = input.control
  const key = JSON.stringify([record.repository, record.target, record.operationId, record.recordId])
  if (seen.has(key)) return fail('Recovery predecessor lineage is cyclic')
  const nextSeen = new Set(seen).add(key)
  const history = input.histories.filter((entry) => equalScope(entry.source.scope, record))
  const nativeHistory = history[0]
  if (history.length !== 1 || nativeHistory === undefined || !nativeHistory.source.complete)
    return fail('Recovery control native history is unavailable')
  const publication = authenticatePublication(record, nativeHistory)
  if (!publication.ok) return publication
  const reconstructed = fixRecoveryProposalFromControl(record)
  if (!reconstructed.ok) return reconstructed
  const proposal = reconstructed.value
  const facts = inspectRecoveryHistoricalFacts(proposal, input.histories)
  if (!facts.ok) return facts
  const lineage = unclosedLineage(facts.value.histories, proposal.uw, nextSeen)
  if (!matchesLineage(lineage, proposal))
    return fail('Recovery predecessor does not match the authenticated owner lineage')
  if (!uniqueCompetitor(input.histories, proposal, publication.value))
    return fail('Recovery owner has conflicting controls')
  return { ok: true, value: { control: record, proposal, digest: record.payload.proposalDigest } }
}
