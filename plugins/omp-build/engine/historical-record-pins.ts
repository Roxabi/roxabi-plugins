import { isDeepStrictEqual } from 'node:util'
import type { RecordInputRef } from './action-input-refs.ts'
import type { DecodedHistory, History } from './history-schema.ts'
import type { Scope } from './record-values.ts'

// Keep selected identities and their native readbacks as evidence, never as implicit authority roots.
const observedRecords = Symbol.for('omp-build.historical-record-pins')
type RecordObservation = { selected: Set<string>; cited: Map<string, History | null> }
type ObservedHistory = History & { [observedRecords]?: RecordObservation }
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

export function noteObservedRecordPin(source: ObservedHistory, ref: RecordInputRef, cited: History) {
  let verified = source[observedRecords]
  if (verified === undefined) {
    verified = { selected: new Set(), cited: new Map() }
    Object.defineProperty(source, observedRecords, { enumerable: true, value: verified })
  }
  const key = scopeKey(ref.record.scope)
  verified.selected.add(recordKey(ref))
  const previous = verified.cited.get(key)
  verified.cited.set(key, previous === undefined || (previous !== null && sameRead(previous, cited)) ? cited : null)
}

export function inheritObservedRecordPins(original: ObservedHistory, parsed: History) {
  const verified = original[observedRecords]
  if (verified !== undefined) Object.defineProperty(parsed, observedRecords, { enumerable: true, value: verified })
}

export function hasObservedRecordPin(histories: readonly DecodedHistory[], ref: RecordInputRef) {
  const key = recordKey(ref)
  return (
    histories.some(({ source }: { source: ObservedHistory }) => source[observedRecords]?.selected.has(key) === true) &&
    getObservedRecordHistory(histories, ref.record.scope) !== null
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
