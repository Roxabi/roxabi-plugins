import { canonicalValueDigest } from './canonical-value.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope, fail } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { Scope } from './record-values.ts'
import type { Result } from './result.ts'
import type { UwCompletionObservation } from './uw-completion-types.ts'
import { scopeKey, type UwNativeNode, validateUwGraph } from './uw-graph.ts'
import { type NativeIssueObservation, nativeObservationDigest } from './uw-native-observation-schema.ts'
import { bindExternalRef, historyFor } from './workflow-control.ts'
import { type AssessResultRecord, isAssessResult } from './workflow-spec-assessment.ts'
import { authenticatedAssessResult } from './workflow-spec-authentication-chain.ts'

export type NativeObservationReader = (node: UwNativeNode) => NativeIssueObservation | null
export type AssessmentDeltaInput = {
  before: UwCompletionObservation
  after: UwCompletionObservation
  assessment: ExternalRecordRef
  mandate: ExternalRecordRef
}
export const compositionStale = <T>(message: string): Result<T> =>
  fail([diagnostic('material-composition-stale', message)])
export const sameObservationValue = (a: unknown, b: unknown) => canonicalValueDigest(a) === canonicalValueDigest(b)

export function issueFromScope(scope: Scope): { repository: string; number: number } | null {
  const prefix = `${scope.repository}#`
  if (!scope.target.startsWith(prefix)) return null
  const suffix = scope.target.slice(prefix.length)
  if (!/^[1-9][0-9]*$/.test(suffix)) return null
  const number = Number(suffix)
  return Number.isSafeInteger(number) ? { repository: scope.repository, number } : null
}

function assessmentCutProblem(input: AssessmentDeltaInput, native: NativeObservationReader): string | null {
  const { before, after, assessment, mandate } = input
  if (
    before.status !== 'complete' ||
    after.status !== 'complete' ||
    !validateUwGraph(before.graph).ok ||
    !validateUwGraph(after.graph).ok
  )
    return 'Assessment observations and native graphs must be complete'
  if (
    !equalScope(before.root, after.root) ||
    !equalScope(before.root, before.graph.root) ||
    !equalScope(after.root, after.graph.root)
  )
    return 'Observation or graph root changed during assessment'
  if (!equalScope(assessment.scope, mandate.scope)) return 'Assessment does not belong to the parent mandate scope'
  if (
    new Set(before.histories.map((history) => scopeKey(history.source.scope))).size !== before.histories.length ||
    new Set(after.histories.map((history) => scopeKey(history.source.scope))).size !== after.histories.length
  )
    return 'Assessment observations contain ambiguous duplicate history scopes'
  if (before.graph.nodes.length !== after.graph.nodes.length) return 'Native graph membership changed during assessment'
  for (const previous of before.graph.nodes) {
    const current = after.graph.nodes.find((node) => equalScope(node.uw, previous.uw))
    const oldNative = native(previous)
    const newNative = current === undefined ? null : native(current)
    if (
      oldNative === null ||
      newNative === null ||
      nativeObservationDigest(oldNative) !== nativeObservationDigest(newNative)
    )
      return 'Native graph changed during assessment'
  }
  return null
}

function assessmentPair(
  input: AssessmentDeltaInput,
): Result<{ record: AssessResultRecord; home: DecodedHistory; startRef: ExternalRecordRef }> {
  const { after, assessment, mandate } = input
  const home = historyFor(assessment.scope, after.histories)
  if (home === null) return compositionStale('Assessment result history is unavailable')
  const result = bindExternalRef(assessment, home)
  if (!result.ok || !isAssessResult(result.value))
    return compositionStale('Actual canonical assessment result is unavailable')
  const authenticated = authenticatedAssessResult(result.value, after.histories, mandate)
  if (!authenticated.ok) return fail(authenticated.evidence)
  const startRef = result.value.payload.start
  if (!equalScope(startRef.scope, assessment.scope))
    return compositionStale('Assessment start and result are not in the same scope')
  const start = bindExternalRef(startRef, home)
  if (
    !start.ok ||
    start.value.kind !== 'action-receipt' ||
    start.value.payload.action !== 'assess-spec' ||
    start.value.payload.phase !== 'start'
  )
    return compositionStale('Actual canonical assessment start is unavailable')
  return { ok: true, value: { record: authenticated.record, home, startRef } }
}

function assessmentPairHistoryProblem(
  home: DecodedHistory,
  beforeHome: DecodedHistory | null,
  assessment: ExternalRecordRef,
  startRef: ExternalRecordRef,
): string | null {
  if (
    beforeHome === null ||
    beforeHome.operations.some(
      (entry) => entry.recordId === assessment.recordId || entry.recordId === startRef.recordId,
    )
  )
    return 'Assessment pair was already present before execution'
  const added = home.operations.filter(
    (entry) => entry.recordId === assessment.recordId || entry.recordId === startRef.recordId,
  )
  if (
    added.length !== 2 ||
    added.some(
      (entry) =>
        entry.status !== 'complete' || entry.authority === 'foreign' || entry.record?.kind !== 'action-receipt',
    )
  )
    return 'Assessment pair envelopes are incomplete or ambiguous'
  const ids = new Set(added.flatMap((entry) => entry.parts.map((part) => part.nativeId)))
  const restored = {
    ...home,
    operations: home.operations.filter((entry) => !added.includes(entry)),
    source: { ...home.source, comments: home.source.comments.filter((comment) => !ids.has(comment.nativeId)) },
  }
  return sameObservationValue(beforeHome, restored)
    ? null
    : 'Assessment history changed beyond the exact opened and result envelopes'
}

function unrelatedAssessmentHistoryProblem(input: AssessmentDeltaInput): string | null {
  const { before, after, assessment } = input
  if (before.histories.length !== after.histories.length) return 'History scope set changed during assessment'
  for (const previous of before.histories) {
    if (equalScope(previous.source.scope, assessment.scope)) continue
    const current = historyFor(previous.source.scope, after.histories)
    if (current === null || !sameObservationValue(previous, current))
      return 'An unrelated history changed during assessment'
  }
  return null
}

export function checkAssessmentDelta(
  input: AssessmentDeltaInput,
  native: NativeObservationReader,
): Result<AssessResultRecord> {
  const cutProblem = assessmentCutProblem(input, native)
  if (cutProblem !== null) return compositionStale(cutProblem)
  const pair = assessmentPair(input)
  if (!pair.ok) return pair
  const { home, startRef, record } = pair.value
  const beforeHome = historyFor(input.assessment.scope, input.before.histories)
  const historyProblem = assessmentPairHistoryProblem(home, beforeHome, input.assessment, startRef)
  if (historyProblem !== null) return compositionStale(historyProblem)
  const unrelated = unrelatedAssessmentHistoryProblem(input)
  return unrelated === null ? { ok: true, value: record } : compositionStale(unrelated)
}
