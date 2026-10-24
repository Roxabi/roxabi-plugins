import type { NativeChildResult, NativeProofBashCall } from '../omp/review-runtime/contracts.ts'

export function emptyChild(): NativeChildResult {
  return {
    id: null,
    expectedId: null,
    submissions: [],
    proofEvidence: null,
    bashCalls: [],
    raw: null,
    partialText: null,
    structured: null,
    usable: false,
    reason: 'absent',
  }
}

export function nativeOutcome(
  child: NativeChildResult,
  usable: boolean,
): { completion: 'completed' | 'incomplete'; strict: 'valid' | 'invalid' | 'absent'; raw: NativeChildResult['raw'] } {
  return {
    completion: child.usable ? 'completed' : 'incomplete',
    strict: usable ? 'valid' : 'invalid',
    raw: child.raw,
  }
}

export function hasObservedNativeCapture(child: NativeChildResult): boolean {
  return (
    child.id !== null ||
    child.raw !== null ||
    child.submissions.length > 0 ||
    child.partialText !== null ||
    (child.bashCalls?.length ?? 0) > 0
  )
}

/**
 * Implement native outcome. nativeOutcomeSchema: {completion,strict,raw,bashCalls?}.
 * raw = untouched SDK terminal. bashCalls = claim-referenced NativeProofBashCall copies
 * (input+result, conflicting duplicates kept); unreferenced dropped. Never wrap raw.
 */
export function implementNativeOutcome(
  child: NativeChildResult,
  usable: boolean,
  claimedIds: ReadonlySet<string>,
): {
  completion: 'completed' | 'incomplete'
  strict: 'valid' | 'invalid' | 'absent'
  raw: NativeChildResult['raw']
  bashCalls?: NativeProofBashCall[]
} {
  const bashCalls = (child.bashCalls ?? []).filter((call) => claimedIds.has(call.toolCallId))
  return {
    completion: child.usable ? 'completed' : 'incomplete',
    strict: usable ? 'valid' : 'invalid',
    raw: child.raw,
    ...(bashCalls.length > 0 ? { bashCalls } : {}),
  }
}
