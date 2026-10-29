import { canonicalValueDigest, validateActionInputs } from './action-input.ts'
import type { CanonicalRecord } from './record-schema.ts'

type Contribution = Extract<CanonicalRecord, { kind: 'contribution' }>

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** Verify the exact native terminal, executed yield and conserved submission. */
export function genuineCorrectionSource(contribution: Contribution): boolean {
  const source = contribution.payload
  const native = source.native
  const observation = native?.observation
  const action = source.host.action
  if (
    source.content !== 'action-result' ||
    source.host.origin !== 'native' ||
    !native ||
    native.completion !== 'completed' ||
    native.strict !== 'valid' ||
    !observation ||
    !action ||
    !validateActionInputs(action.inputs).ok
  )
    return false
  if (
    observation.actionId !== action.actionId ||
    observation.childId !== source.host.childId ||
    observation.submissionIndex !== observation.submission.attemptIndex
  )
    return false
  const raw = object(object(native.raw)?.terminal)
  const output = object(raw?.structuredOutput)
  const data = observation.submission.data
  if (
    raw?.id !== observation.childId ||
    output?.status !== 'valid' ||
    output.data === undefined ||
    data === null ||
    canonicalValueDigest(output.data) !== canonicalValueDigest(data) ||
    canonicalValueDigest(source.structured) !== canonicalValueDigest(data) ||
    !source.rawAttempts.some((item) => canonicalValueDigest(item) === canonicalValueDigest(observation.submission))
  )
    return false
  const yielded = object(observation.submission.raw)
  const execution = object(yielded?.executionArguments)
  return (
    typeof yielded?.toolCallId === 'string' &&
    yielded.toolCallId.length > 0 &&
    execution?.data !== undefined &&
    canonicalValueDigest(execution.data) === canonicalValueDigest(data)
  )
}
