import type { FixRecoveryObservation } from './fix-recovery-control-schema.ts'
import type { PartPin, ReservedRecordIdentity } from './fix-recovery-identities.ts'
import { commentAsPartPin, partPinsEqual } from './fix-recovery-part-pins.ts'
import { recoveryRetiredParts } from './fix-recovery-projection.ts'
import type { FixOwnerSettledPayload } from './fix-recovery-schema.ts'
import { frameFrom } from './history-framing.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope } from './record-diagnostics.ts'
import { recordIntegrity } from './record-integrity.ts'
import type { Result } from './result.ts'
import { scopeKey } from './uw-graph.ts'

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const failure = (message: string): Result<never> => ({ ok: false, diagnostics: [diagnostic('unconfirmed', message)] })
type Entry = { key: string; parts: PartPin[] }
type Operation = DecodedHistory['operations'][number]

function pinnedParts(history: DecodedHistory, operation: Operation): Result<PartPin[]> {
  const parts: PartPin[] = []
  for (const comment of operation.parts) {
    const pin = commentAsPartPin(comment)
    if (pin === null) return failure('Recovery protocol part lacks immutable native identity')
    parts.push(pin)
  }
  parts.sort((a, b) => a.part - b.part || compare(a.nativeId, b.nativeId) || compare(a.locator, b.locator))
  if (
    parts.some((part, index) => {
      const previous = parts[index - 1]
      return (
        (previous !== undefined && previous.part === part.part) ||
        history.source.comments.filter((comment) => {
          const sourcePin = commentAsPartPin(comment)
          return sourcePin !== null && partPinsEqual(sourcePin, part)
        }).length !== 1
      )
    })
  )
    return failure('Recovery operation parts are duplicated or absent from the raw native source')
  return { ok: true, value: parts }
}

function operationEntry(
  history: DecodedHistory,
  operation: Operation,
  settlement: FixOwnerSettledPayload,
  earlier: readonly ReservedRecordIdentity<string>[],
  retired: ReadonlyMap<string, ReadonlySet<string>>,
): Result<Entry> {
  if (operation.status !== 'complete' && operation.status !== 'incomplete')
    return failure('Recovery source contains invalid or ambiguous trusted protocol material')
  const allRetired = operation.parts.every(
    (part) => part.nativeId !== null && retired.get(scopeKey(history.source.scope))?.has(part.nativeId),
  )
  const reservations = [
    ...settlement.outbound.map((entry) => entry.identity),
    ...earlier.filter(() => allRetired),
  ].filter(
    (identity) =>
      equalScope(identity.scope, history.source.scope) &&
      identity.operationId === operation.operationId &&
      identity.recordId === operation.recordId &&
      identity.kind === operation.kind,
  )
  if (operation.status === 'incomplete' && reservations.length !== 1)
    return failure('Recovery source contains an unrelated incomplete protocol operation')
  const record = operation.record
  const runId = record?.runId ?? reservations[0]?.runId
  if (
    !runId ||
    !operation.operationId ||
    !operation.recordId ||
    !operation.kind ||
    (record !== null && recordIntegrity(operation.parts, record) !== null)
  )
    return failure('Recovery source contains an unpinnable protocol operation')
  const parts = pinnedParts(history, operation)
  if (!parts.ok) return parts
  return {
    ok: true,
    value: {
      key: [scopeKey(history.source.scope), operation.kind, runId, operation.operationId, operation.recordId].join(
        '\0',
      ),
      parts: parts.value,
    },
  }
}

function validateRawParts(history: DecodedHistory, parts: readonly PartPin[]): Result<true> {
  for (const comment of history.source.comments) {
    if (comment.author !== history.source.expectedAuthor && comment.author !== history.source.stopAuthor) continue
    if (frameFrom(comment) === null) continue
    const pin = commentAsPartPin(comment)
    if (pin === null || parts.filter((part) => partPinsEqual(part, pin)).length !== 1)
      return failure('Recovery observation omitted trusted raw protocol material')
  }
  return { ok: true, value: true }
}

function historyCut(
  history: DecodedHistory,
  settlement: FixOwnerSettledPayload,
  earlier: readonly ReservedRecordIdentity<string>[],
  retired: ReadonlyMap<string, ReadonlySet<string>>,
): Result<FixRecoveryObservation['histories'][number]> {
  if (!history.source.complete) return failure('Recovery source history is incomplete')
  const entries: Entry[] = []
  for (const operation of history.operations) {
    if (operation.authority === 'foreign') continue
    const entry = operationEntry(history, operation, settlement, earlier, retired)
    if (!entry.ok) return entry
    entries.push(entry.value)
  }
  entries.sort((a, b) => compare(a.key, b.key))
  const parts = entries.flatMap((entry) => entry.parts)
  const raw = validateRawParts(history, parts)
  if (!raw.ok) return raw
  if (
    new Set(entries.map((entry) => entry.key)).size !== entries.length ||
    new Set(parts.map((part) => part.nativeId)).size !== parts.length
  )
    return failure('Recovery source repeats an operation or native part')
  return {
    ok: true,
    value: {
      scope: { ...history.source.scope },
      expectedAuthor: history.source.expectedAuthor,
      stopAuthor: history.source.stopAuthor,
      complete: true,
      parts,
    },
  }
}

export function captureCuts(
  histories: readonly DecodedHistory[],
  settlement: FixOwnerSettledPayload,
): Result<FixRecoveryObservation['histories']> {
  const retired = recoveryRetiredParts(histories)
  if (!retired.ok) return retired
  const earlier = histories.flatMap((history) =>
    history.operations.flatMap((operation) =>
      operation.status === 'complete' && operation.record?.kind === 'fix-recovery'
        ? operation.record.payload.cuts.flatMap((cut) =>
            cut.members.flatMap((member) => (member.disposition === 'retire-incomplete' ? [member.identity] : [])),
          )
        : [],
    ),
  )
  const cuts: FixRecoveryObservation['histories'] = []
  for (const history of histories) {
    const cut = historyCut(history, settlement, earlier, retired.value)
    if (!cut.ok) return cut
    cuts.push(cut.value)
  }
  cuts.sort((a, b) => compare(scopeKey(a.scope), scopeKey(b.scope)))
  return { ok: true, value: cuts }
}
