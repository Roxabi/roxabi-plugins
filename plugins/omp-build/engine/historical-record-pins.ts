import type { RecordInputRef } from './action-input-refs.ts'
import type { DecodedHistory, History } from './history-schema.ts'

// Keep only selected identities from independently observed foreign scopes, never whole authority histories.
const observedRecords = Symbol.for('omp-build.historical-record-pins')
type ObservedHistory = History & { [observedRecords]?: Set<string> }

function recordKey(ref: RecordInputRef) {
  const { scope, kind, recordId } = ref.record
  return JSON.stringify([scope.repository, scope.target, kind, recordId, ref.selector, ref.digest])
}

export function noteObservedRecordPin(source: ObservedHistory, ref: RecordInputRef) {
  let verified = source[observedRecords]
  if (verified === undefined) {
    verified = new Set()
    Object.defineProperty(source, observedRecords, { enumerable: true, value: verified })
  }
  verified.add(recordKey(ref))
}

export function inheritObservedRecordPins(original: ObservedHistory, parsed: History) {
  const verified = original[observedRecords]
  if (verified !== undefined) Object.defineProperty(parsed, observedRecords, { enumerable: true, value: verified })
}

export function hasObservedRecordPin(histories: readonly DecodedHistory[], ref: RecordInputRef) {
  const key = recordKey(ref)
  return histories.some(({ source }: { source: ObservedHistory }) => source[observedRecords]?.has(key) === true)
}
