import { bindExternalRef, canonicalValueDigest, equalScope, reviewSubjectBound } from '../dist/contracts.js'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { Result } from '../engine/result.ts'
import type { ActionSubject, ReviewRootRef, UwActionRequest } from './uw-action-contract.ts'
import { actionFailure } from './uw-action-result.ts'

/** Reauthenticate the selected inventory against its current complete subject history. */
export function authenticateReviewRoot(
  request: UwActionRequest,
  histories: readonly DecodedHistory[],
  reviewedFingerprint: string | undefined,
  root: ReviewRootRef | undefined,
  subject: ActionSubject,
): Result<true> {
  if (root === undefined) return { ok: true, value: true }
  const scope = subject.kind === 'uw' ? (subject.pullRequest ?? subject.uw) : subject.pullRequest
  if (request.purpose !== 'review' || !equalScope(root.scope, scope))
    return actionFailure('review-input-changed', 'Selected review root is outside the current review subject')
  const matching = histories.filter((history) => equalScope(history.source.scope, root.scope))
  if (matching.length !== 1 || matching[0] === undefined)
    return actionFailure('review-input-changed', 'Selected review root history is unavailable')
  const bound = bindExternalRef(root, matching[0])
  if (!bound.ok) return bound
  const record = bound.value
  if (
    record.kind !== 'review-attempt' ||
    record.payload.stage !== 'initial' ||
    record.payload.purpose !== 'review' ||
    record.payload.rootAttemptId !== record.recordId ||
    record.payload.actionInputDigest !== reviewedFingerprint ||
    !reviewSubjectBound(record, record.payload) ||
    canonicalValueDigest(record.payload.inputSnapshot.manifest.subject) !== canonicalValueDigest(subject) ||
    (record.payload.subject.kind === 'epic-range' &&
      record.payload.subject.range !== `${request.code.base}..${request.code.head}`) ||
    record.payload.inputSnapshot.fingerprint !== reviewedFingerprint ||
    record.payload.candidateGitSHA !== request.code.head
  )
    return actionFailure('review-input-changed', 'Selected review root does not match the reviewed inputs')
  return { ok: true, value: true }
}
