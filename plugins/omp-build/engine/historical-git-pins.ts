import { createHash } from 'node:crypto'
import type { PinnedFileRef } from './action-input-refs.ts'
import type { ActionInputs } from './action-input-schema.ts'
import type { DecodedHistory, History } from './history-schema.ts'

// The installed bundle and source adapters can share evidence without making it part of the wire history.
const observedPins = Symbol.for('omp-build.historical-git-pins')
type ObservedHistory = History & { [observedPins]?: Set<string> }

export function gitPinCoordinates(pin: PinnedFileRef) {
  return `${pin.repository}\0${pin.commit}\0${pin.path}`
}

function gitPinKey(pin: PinnedFileRef) {
  return `${gitPinCoordinates(pin)}\0${pin.digest}`
}

export function recordGitPinBytes(history: DecodedHistory, pins: Iterable<PinnedFileRef>, bytes: Uint8Array) {
  const digest = createHash('sha256').update(bytes).digest('hex')
  const source: ObservedHistory = history.source
  for (const pin of pins) {
    if (digest !== pin.digest) continue
    let verified = source[observedPins]
    if (verified === undefined) {
      verified = new Set()
      Object.defineProperty(source, observedPins, { enumerable: true, value: verified })
    }
    verified.add(gitPinKey(pin))
  }
}

/** Keep trusted adapter evidence through wire-schema validation, which clones the source. */
export function inheritObservedGitPins(original: ObservedHistory, parsed: History) {
  const verified = original[observedPins]
  if (verified !== undefined) Object.defineProperty(parsed, observedPins, { enumerable: true, value: verified })
}

export function hasObservedGitPin(histories: readonly DecodedHistory[], pin: PinnedFileRef) {
  const key = gitPinKey(pin)
  return histories.some(({ source }: { source: ObservedHistory }) => source[observedPins]?.has(key) === true)
}

export function expandedGitPinsObserved(histories: readonly DecodedHistory[], inputs: ActionInputs) {
  return inputs.manifest.expandedContext.every((ref) => ref.source !== 'git-file' || hasObservedGitPin(histories, ref))
}
