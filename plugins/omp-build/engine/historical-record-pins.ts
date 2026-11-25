import { isDeepStrictEqual } from 'node:util'
import type { RecordInputRef } from './action-input-refs.ts'
import type { DecodedHistory, History } from './history-schema.ts'
import { nativeInstant } from './record-integrity.ts'
import type { Scope } from './record-values.ts'

// Keep selected identities and their native readbacks as evidence, never as implicit authority roots.
const observedRecords = Symbol.for('omp-build.historical-record-pins')
const recordPinCutoff = Symbol.for('omp-build.historical-record-pin-cutoff')
type RecordObservation = { selected: Map<string, number | null>; cited: Map<string, History | null> }
type ObservedHistory = History & { [observedRecords]?: RecordObservation; [recordPinCutoff]?: number }
const scopeKey = ({ repository, target }: Scope) => JSON.stringify([repository, target])

function sameRead(left: History, right: History): boolean {
  return (
    left === right ||
    (left.complete === right.complete &&
      left.expectedAuthor === right.expectedAuthor &&
      left.stopAuthor === right.stopAuthor &&
      isDeepStrictEqual(left.comments, right.comments))
  )
}

function recordKey(ref: RecordInputRef) {
  const { scope, kind, recordId } = ref.record
  return JSON.stringify([scope.repository, scope.target, kind, recordId, ref.selector, ref.digest])
}

// Only the parts of the already bound record establish its time, not unrelated comments in the read.
function latestRecordPart(ref: RecordInputRef, cited: DecodedHistory): number | null {
  let latest = -Infinity
  for (const operation of cited.operations) {
    if (
      operation.authority === 'foreign' ||
      operation.status !== 'complete' ||
      operation.record?.recordId !== ref.record.recordId ||
      operation.record.kind !== ref.record.kind
    )
      continue
    for (const part of operation.parts) {
      const created = nativeInstant(part.createdAt)
      if (created === null || part.updatedAt !== part.createdAt) return null
      latest = Math.max(latest, created)
    }
  }
  return Number.isFinite(latest) ? latest : null
}

export function noteObservedRecordPin(source: ObservedHistory, ref: RecordInputRef, cited: DecodedHistory) {
  let verified = source[observedRecords]
  if (verified === undefined) {
    verified = { selected: new Map(), cited: new Map() }
    Object.defineProperty(source, observedRecords, { enumerable: true, value: verified })
  }
  const key = scopeKey(ref.record.scope)
  verified.selected.set(recordKey(ref), latestRecordPart(ref, cited))
  const previous = verified.cited.get(key)
  const read = cited.source
  verified.cited.set(key, previous === undefined || (previous !== null && sameRead(previous, read)) ? read : null)
}

export function inheritObservedRecordPins(original: ObservedHistory, parsed: History, before?: number) {
  const verified = original[observedRecords]
  if (verified !== undefined) Object.defineProperty(parsed, observedRecords, { enumerable: true, value: verified })
  const inherited = original[recordPinCutoff]
  const cutoff = before === undefined ? inherited : Math.min(before, inherited ?? before)
  if (cutoff !== undefined) Object.defineProperty(parsed, recordPinCutoff, { enumerable: true, value: cutoff })
}

export function hasObservedRecordPin(histories: readonly DecodedHistory[], ref: RecordInputRef) {
  const key = recordKey(ref)
  return (
    histories.some(({ source }: { source: ObservedHistory }) => {
      const observedAt = source[observedRecords]?.selected.get(key)
      const cutoff = source[recordPinCutoff]
      return observedAt !== undefined && (cutoff === undefined || (observedAt !== null && observedAt < cutoff))
    }) && getObservedRecordHistory(histories, ref.record.scope) !== null
  )
}

export function getObservedRecordHistory(histories: readonly DecodedHistory[], scope: Scope): History | null {
  const key = scopeKey(scope)
  let selected: History | undefined
  for (const { source } of histories as readonly { source: ObservedHistory }[]) {
    const cited = source[observedRecords]?.cited.get(key)
    if (cited === undefined) continue
    if (cited === null || (selected !== undefined && !sameRead(selected, cited))) return null
    selected = cited
  }
  return selected ?? null
}
