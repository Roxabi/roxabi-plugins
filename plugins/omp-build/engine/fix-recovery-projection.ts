import type { FixRecoveryProposal } from './fix-recovery-control-schema.ts'
import { matchesCompletePin } from './fix-recovery-discovery-records.ts'
import { commentAsPartPin, observedPartsMatch, partPinsEqual } from './fix-recovery-part-pins.ts'
import { replayFixRecoveryControl, validateProspectiveFixRecoveryControl } from './fix-recovery-replay.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope } from './record-diagnostics.ts'
import { recordIntegrity } from './record-integrity.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Result } from './result.ts'
import { scopeKey } from './uw-graph.ts'
/** Requests neutrally closed by confirmed, fully replayed pre-decision controls. */
export function recoveryClosedRequests(
  histories: readonly DecodedHistory[],
): Result<readonly { scope: { repository: string; target: string }; kind: 'fix-request'; recordId: string }[]> {
  const closed: { scope: { repository: string; target: string }; kind: 'fix-request'; recordId: string }[] = []
  for (const history of histories) {
    for (const operation of history.operations) {
      if (
        operation.authority === 'foreign' ||
        operation.status !== 'complete' ||
        operation.record?.kind !== 'fix-recovery'
      )
        continue
      const replay = replayFixRecoveryControl({ control: operation.record, histories })
      if (!replay.ok) return replay
      if (replay.value.proposal.phase !== 'close-predecision') continue
      const identity = replay.value.proposal.target.request.identity
      closed.push({ scope: identity.scope, kind: 'fix-request', recordId: identity.recordId })
    }
  }
  return { ok: true, value: closed }
}

const fail = (): Result<never> => ({
  ok: false,
  diagnostics: [diagnostic('ambiguous', 'Confirmed recovery cut does not match immutable raw operation membership')],
})

function collectProposals(
  histories: readonly DecodedHistory[],
  prospective?: Extract<CanonicalRecord, { kind: 'fix-recovery' }>,
): Result<FixRecoveryProposal[]> {
  const controls = histories
    .flatMap((history) => history.operations)
    .filter(
      (operation) =>
        operation.authority !== 'foreign' &&
        operation.status === 'complete' &&
        operation.record?.kind === 'fix-recovery',
    )
  const proposals: FixRecoveryProposal[] = []
  for (const operation of controls) {
    if (operation.record?.kind !== 'fix-recovery') return fail()
    const replay = replayFixRecoveryControl({ control: operation.record, histories })
    if (!replay.ok) return replay
    proposals.push(replay.value.proposal)
  }
  if (
    prospective !== undefined &&
    !controls.some(
      (operation) =>
        operation.record?.recordId === prospective.recordId &&
        operation.record.operationId === prospective.operationId &&
        equalScope(operation.record, prospective),
    )
  ) {
    const candidate = validateProspectiveFixRecoveryControl({ control: prospective, histories })
    if (!candidate.ok) return candidate
    proposals.push(candidate.value)
  }
  return { ok: true, value: proposals }
}

type Cut = FixRecoveryProposal['cuts'][number]
type RetiredMember = Exclude<Cut['members'][number], { disposition: 'keep-complete' }>
type Operation = DecodedHistory['operations'][number]

function validOperation(current: Operation, member: RetiredMember): boolean {
  const identity = member.identity
  if (
    current.authority === 'foreign' ||
    current.operationId !== identity.operationId ||
    current.recordId !== identity.recordId ||
    current.kind !== identity.kind ||
    (current.status !== 'incomplete' && current.status !== 'complete') ||
    !observedPartsMatch(member.observedParts, current, false) ||
    recordIntegrity(current.parts, identity) !== null
  )
    return false
  return (
    current.record === null ||
    (equalScope(current.record, identity.scope) &&
      current.record.kind === identity.kind &&
      current.record.runId === identity.runId &&
      current.record.operationId === identity.operationId &&
      current.record.recordId === identity.recordId)
  )
}

function retireMember(
  home: DecodedHistory,
  cut: Cut,
  member: RetiredMember,
  retired: Map<string, Set<string>>,
): Result<void> {
  const identity = member.identity
  const operations = home.operations.filter(
    (entry) => entry.operationId === identity.operationId || entry.recordId === identity.recordId,
  )
  if (operations.length === 0) return member.observedParts.length === 0 ? { ok: true, value: undefined } : fail()
  const current = operations[0]
  if (operations.length !== 1 || current === undefined || !validOperation(current, member)) return fail()
  const pins = current.parts.map(commentAsPartPin)
  if (pins.some((pin) => pin === null)) return fail()
  const known = pins.filter((pin) => pin !== null)
  const totals = new Set(known.map((pin) => pin.total))
  if (
    totals.size > 1 ||
    new Set(known.map((pin) => pin.part)).size !== known.length ||
    known.some(
      (pin) =>
        pin.author !== home.source.expectedAuthor ||
        home.source.comments.filter((comment) => {
          const actual = commentAsPartPin(comment)
          return actual !== null && partPinsEqual(pin, actual)
        }).length !== 1,
    )
  )
    return fail()
  const key = scopeKey(cut.scope)
  const set = retired.get(key) ?? new Set<string>()
  for (const pin of known) {
    if (set.has(pin.nativeId)) return fail()
    set.add(pin.nativeId)
  }
  retired.set(key, set)
  return { ok: true, value: undefined }
}

function validateCut(histories: readonly DecodedHistory[], cut: Cut, retired: Map<string, Set<string>>): Result<void> {
  const homes = histories.filter((history) => equalScope(history.source.scope, cut.scope))
  const home = homes[0]
  if (homes.length !== 1 || home === undefined || !home.source.complete) return fail()
  for (const member of cut.members) {
    if (member.disposition === 'keep-complete') {
      if (!matchesCompletePin(histories, member.record)) return fail()
    } else {
      const result = retireMember(home, cut, member, retired)
      if (!result.ok) return result
    }
  }
  return { ok: true, value: undefined }
}

/** Exact raw comment identities to omit from effective membership after replay, not from the native source. */
export function recoveryRetiredParts(
  histories: readonly DecodedHistory[],
  prospective?: Extract<CanonicalRecord, { kind: 'fix-recovery' }>,
): Result<ReadonlyMap<string, ReadonlySet<string>>> {
  const proposals = collectProposals(histories, prospective)
  if (!proposals.ok) return proposals
  const retired = new Map<string, Set<string>>()
  for (const proposal of proposals.value) {
    for (const cut of proposal.cuts) {
      const result = validateCut(histories, cut, retired)
      if (!result.ok) return result
    }
  }
  return { ok: true, value: retired }
}
