import { isDeepStrictEqual } from 'node:util'
import type { RecordInputRef } from './action-input-refs.ts'
import type { DecodedHistory, History } from './history-schema.ts'
import { nativeInstant } from './record-integrity.ts'
import type { Scope } from './record-values.ts'

// Keep selected identities and their native readbacks as evidence, never as implicit authority roots.
const observedRecords = Symbol.for('omp-build.historical-record-pins')
const recordPinCutoff = Symbol.for('omp-build.historical-record-pin-cutoff')
type CitedRecord = Pick<History, 'expectedAuthor' | 'stopAuthor' | 'comments'> & { digestMatched: boolean }
type RecordObservation = { selected: Map<string, number | null>; cited: Map<string, Map<string, CitedRecord | null>> }
type ObservedHistory = History & { [observedRecords]?: RecordObservation; [recordPinCutoff]?: number }
const scopeKey = ({ repository, target }: Scope) => JSON.stringify([repository, target])

const citedRecordKey = ({ kind, recordId }: RecordInputRef['record']) => JSON.stringify([kind, recordId])
const recordKey = (ref: RecordInputRef) =>
  JSON.stringify([scopeKey(ref.record.scope), citedRecordKey(ref.record), ref.selector, ref.digest])

// Only the parts of the already bound record establish its time, not unrelated comments in the read.
function latestRecordPart(parts: History['comments']): number | null {
  let latest = -Infinity
  for (const part of parts) {
    const created = nativeInstant(part.createdAt)
    if (created === null || part.updatedAt !== part.createdAt) return null
    latest = Math.max(latest, created)
  }
  return Number.isFinite(latest) ? latest : null
}

export function noteObservedRecordPin(
  source: ObservedHistory,
  ref: RecordInputRef,
  cited: DecodedHistory,
  digestMatches: boolean,
) {
  let verified = source[observedRecords]
  if (verified === undefined) {
    verified = { selected: new Map(), cited: new Map() }
    Object.defineProperty(source, observedRecords, { enumerable: true, value: verified })
  }
  const key = scopeKey(ref.record.scope)
  let records = verified.cited.get(key)
  if (records === undefined) {
    records = new Map()
    verified.cited.set(key, records)
  }
  const identity = citedRecordKey(ref.record)
  const comments = cited.operations
    .filter(
      ({ authority, record, status }) =>
        authority !== 'foreign' &&
        status === 'complete' &&
        record?.recordId === ref.record.recordId &&
        record.kind === ref.record.kind,
    )
    .flatMap(({ parts }) => parts)
    .sort((left, right) => (left.nativeId ?? '').localeCompare(right.nativeId ?? ''))
  const { expectedAuthor, stopAuthor } = cited.source
  const read = { expectedAuthor, stopAuthor, comments, digestMatched: digestMatches }
  const previous = records.get(identity)
  records.set(identity, previous === undefined ? read : mergeCitedRecord(previous, read))
  if (digestMatches) verified.selected.set(recordKey(ref), latestRecordPart(comments))
}

function mergeCitedRecord(left: CitedRecord | null, right: CitedRecord | null): CitedRecord | null {
  if (left === right) return left
  if (
    left === null ||
    right === null ||
    left.expectedAuthor !== right.expectedAuthor ||
    !isDeepStrictEqual(left.comments, right.comments)
  )
    return null
  return {
    ...left,
    stopAuthor: left.stopAuthor === right.stopAuthor ? left.stopAuthor : null,
    digestMatched: left.digestMatched || right.digestMatched,
  }
}

export function inheritObservedRecordPins(original: ObservedHistory, parsed: History, before?: number) {
  const verified = original[observedRecords]
  if (verified !== undefined) Object.defineProperty(parsed, observedRecords, { enumerable: true, value: verified })
  const inherited = original[recordPinCutoff]
  const cutoff = before === undefined ? inherited : Math.min(before, inherited ?? before)
  if (cutoff !== undefined) Object.defineProperty(parsed, recordPinCutoff, { enumerable: true, value: cutoff })
}

function* citedRecords(histories: readonly DecodedHistory[], scope: Scope) {
  const key = scopeKey(scope)
  for (const { source } of histories as readonly { source: ObservedHistory }[]) {
    const records = source[observedRecords]?.cited.get(key)
    if (records !== undefined) yield records
  }
}

export function hasObservedRecordPin(histories: readonly DecodedHistory[], ref: RecordInputRef) {
  const key = recordKey(ref)
  const selected = histories.some(({ source }: { source: ObservedHistory }) => {
    const observedAt = source[observedRecords]?.selected.get(key)
    const cutoff = source[recordPinCutoff]
    return observedAt !== undefined && (cutoff === undefined || (observedAt !== null && observedAt < cutoff))
  })
  if (!selected) return false
  const identity = citedRecordKey(ref.record)
  let merged: CitedRecord | undefined
  for (const records of citedRecords(histories, ref.record.scope)) {
    const record = records.get(identity)
    if (record === undefined) continue
    const next = merged === undefined ? record : mergeCitedRecord(merged, record)
    if (next === null) return false
    merged = next
  }
  return merged !== undefined
}

function mergedCitedRecords(histories: readonly DecodedHistory[], scope: Scope) {
  const merged = new Map<string, CitedRecord | null>()
  for (const records of citedRecords(histories, scope)) {
    for (const [identity, record] of records) {
      const previous = merged.get(identity)
      merged.set(identity, previous === undefined ? record : mergeCitedRecord(previous, record))
    }
  }
  return merged.values()
}

export function getObservedRecordHistory(histories: readonly DecodedHistory[], scope: Scope): History | null {
  const comments: History['comments'] = []
  let metadata: Pick<CitedRecord, 'expectedAuthor' | 'stopAuthor'> | undefined
  for (const record of mergedCitedRecords(histories, scope)) {
    if (record === null || !record.digestMatched) continue
    const { expectedAuthor, stopAuthor } = record
    if (metadata === undefined) metadata = { expectedAuthor, stopAuthor }
    else if (metadata.expectedAuthor !== expectedAuthor) return null
    else if (metadata.stopAuthor !== stopAuthor) metadata.stopAuthor = null
    comments.push(...record.comments)
  }
  return metadata === undefined ? null : { ...metadata, scope, complete: true, comments, diagnostics: [] }
}
