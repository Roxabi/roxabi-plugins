import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope, fail } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Result } from './result.ts'
import { trustedRecoveryRecords } from './review-recovery-history.ts'
import { type InitialPullRequestReviewInventory, isInitialPullRequestReviewInventory } from './review-schema.ts'

export {
  confirmHistoricalReviewInputMatch,
  type HistoricalReviewAssociation,
  historicalReviewAssociations,
  proveHistoricalReviewAssociation,
} from './review-recovery-association.ts'

type ReviewRoot = Extract<CanonicalRecord, { kind: 'review-attempt' }>
type ReviewInterruption = Extract<CanonicalRecord, { kind: 'review-interruption' }>
type PullRequestReviewRoot = ReviewRoot & { payload: InitialPullRequestReviewInventory }
type ReviewReplacementGrant = Extract<CanonicalRecord, { kind: 'review-replacement-grant' }>

function samePullRequestScope(
  left: { repository: string; target: string },
  right: { repository: string; target: string },
): boolean {
  return equalScope(left, right)
}

function sameInputs(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((input) => expected.includes(input))
}

function isInitialPullRequestRoot(record: CanonicalRecord): record is PullRequestReviewRoot {
  if (record.kind !== 'review-attempt' || !isInitialPullRequestReviewInventory(record.payload)) return false
  return record.recordId === record.payload.rootAttemptId && record.payload.replacement === undefined
}

function isReplacementRoot(record: CanonicalRecord): record is PullRequestReviewRoot {
  if (record.kind !== 'review-attempt' || !isInitialPullRequestReviewInventory(record.payload)) return false
  return record.recordId === record.payload.rootAttemptId && record.payload.replacement !== undefined
}

export type ReviewRecovery = {
  normalProgression: 'stopped' | 'eligible'
  replacementGrant: ReviewReplacementGrant | null
}

function completedReview(records: readonly CanonicalRecord[], rootId: string): boolean {
  return records.some((record) => record.kind === 'review' && record.payload.inventoryIds.includes(rootId))
}

function validateInterruption(
  interruption: ReviewInterruption,
  root: ReviewRoot,
  records: readonly CanonicalRecord[],
): string | null {
  const scope = { repository: root.repository, target: root.target }
  const binding = records.find(
    (record) =>
      record.kind === 'workflow-binding' &&
      record.recordId === interruption.payload.historicalBinding.recordId &&
      samePullRequestScope(record, interruption.payload.historicalBinding.scope),
  )
  if (
    interruption.recordId !== `review-interruption-${root.recordId}` ||
    !samePullRequestScope(interruption, scope) ||
    !samePullRequestScope(interruption.payload.historicalBinding.scope, scope) ||
    binding === undefined ||
    !sameInputs(interruption.inputs, [root.recordId, binding.recordId])
  )
    return `Review interruption ${interruption.recordId} is not the authenticated terminal for ${root.recordId}`
  return null
}

function validateGrant(
  grant: ReviewReplacementGrant,
  root: ReviewRoot,
  interruption: ReviewInterruption,
  records: readonly CanonicalRecord[],
): string | null {
  const scope = { repository: root.repository, target: root.target }
  const binding = records.find(
    (record) =>
      record.kind === 'workflow-binding' &&
      record.recordId === grant.payload.binding.recordId &&
      samePullRequestScope(record, grant.payload.binding.scope),
  )
  if (
    grant.recordId !== `review-replacement-grant-${interruption.recordId}` ||
    grant.payload.rootAttemptId !== root.recordId ||
    grant.payload.dispositionId !== interruption.recordId ||
    !samePullRequestScope(grant, scope) ||
    !samePullRequestScope(grant.payload.binding.scope, scope) ||
    binding === undefined ||
    !sameInputs(grant.inputs, [root.recordId, interruption.recordId, binding.recordId])
  )
    return `Replacement grant ${grant.recordId} is not bound to ${root.recordId} and its current binding`
  return null
}

function validateReplacement(
  replacement: PullRequestReviewRoot,
  root: ReviewRoot,
  interruption: ReviewInterruption,
  grant: ReviewReplacementGrant,
): string | null {
  const link = replacement.payload.replacement
  if (
    replacement.recordId !== `review-replacement-inventory-${grant.recordId}` ||
    !samePullRequestScope(replacement, root) ||
    link === undefined ||
    link.rootAttemptId !== root.recordId ||
    link.dispositionId !== interruption.recordId ||
    link.grantId !== grant.recordId ||
    replacement.payload.candidateGitSHA !== grant.payload.candidateGitSHA ||
    replacement.payload.input !== grant.payload.input ||
    !sameInputs(replacement.inputs, [root.recordId, interruption.recordId, grant.recordId])
  )
    return `Replacement inventory ${replacement.recordId} does not exactly consume ${grant.recordId}`
  return null
}

/** Select the sole unfinished historical initial pull-request root that may receive a terminal. */
export function interruptiblePullRequestRoot(history: DecodedHistory): PullRequestReviewRoot | null {
  const trusted = trustedRecoveryRecords(history)
  if (!trusted.ok) return null
  const records = trusted.value
  const candidates = records.filter(
    (record): record is PullRequestReviewRoot =>
      isInitialPullRequestRoot(record) &&
      !completedReview(records, record.recordId) &&
      !records.some(
        (candidate) => candidate.kind === 'review-interruption' && candidate.payload.rootAttemptId === record.recordId,
      ),
  )
  return candidates.length === 1 ? candidates[0] : null
}

/** Read the explicit recovery path without treating a terminal or grant as ordinary review progress. */
type RecoveryRecords = {
  roots: PullRequestReviewRoot[]
  replacements: PullRequestReviewRoot[]
  interruptions: ReviewInterruption[]
  grants: ReviewReplacementGrant[]
}

function classifyRecoveryRecords(records: readonly CanonicalRecord[]): RecoveryRecords {
  return {
    roots: records.filter(isInitialPullRequestRoot),
    replacements: records.filter(isReplacementRoot),
    interruptions: records.filter((record): record is ReviewInterruption => record.kind === 'review-interruption'),
    grants: records.filter((record): record is ReviewReplacementGrant => record.kind === 'review-replacement-grant'),
  }
}

function validateInterruptions(records: readonly CanonicalRecord[], recovery: RecoveryRecords): Result<void> {
  for (const interruption of recovery.interruptions) {
    const root = recovery.roots.find((candidate) => candidate.recordId === interruption.payload.rootAttemptId)
    if (root === undefined)
      return fail([diagnostic('unbound', `Interruption ${interruption.recordId} lacks its historical root`)])
    if (completedReview(records, root.recordId))
      return fail([diagnostic('conflict', `Interrupted root ${root.recordId} also has a completed final review`)])
    const invalid = validateInterruption(interruption, root, records)
    if (invalid !== null) return fail([diagnostic('unbound', invalid)])
  }
  return { ok: true, value: undefined }
}

function validateGrantOrigins(recovery: RecoveryRecords): Result<void> {
  for (const grant of recovery.grants)
    if (
      !recovery.interruptions.some(
        (interruption) =>
          interruption.recordId === grant.payload.dispositionId &&
          interruption.payload.rootAttemptId === grant.payload.rootAttemptId,
      )
    )
      return fail([diagnostic('unbound', `Replacement grant ${grant.recordId} lacks its matching interruption`)])
  return { ok: true, value: undefined }
}

function validateReplacementOrigins(recovery: RecoveryRecords): Result<void> {
  for (const replacement of recovery.replacements)
    if (
      !recovery.grants.some(
        (grant) =>
          replacement.payload.replacement?.grantId === grant.recordId &&
          replacement.payload.replacement.rootAttemptId === grant.payload.rootAttemptId &&
          replacement.payload.replacement.dispositionId === grant.payload.dispositionId,
      )
    )
      return fail([diagnostic('unbound', `Replacement inventory ${replacement.recordId} lacks its matching grant`)])
  if (
    recovery.replacements.some((root) =>
      recovery.interruptions.some((interruption) => interruption.payload.rootAttemptId === root.recordId),
    )
  )
    return fail([diagnostic('conflict', 'Replacement root cannot itself be recovered')])
  return { ok: true, value: undefined }
}

function validateRecoveryTopology(records: readonly CanonicalRecord[], recovery: RecoveryRecords): Result<void> {
  const interruptions = validateInterruptions(records, recovery)
  if (!interruptions.ok) return interruptions
  const grants = validateGrantOrigins(recovery)
  if (!grants.ok) return grants
  return validateReplacementOrigins(recovery)
}

function rootStop(
  root: PullRequestReviewRoot,
  records: readonly CanonicalRecord[],
  recovery: RecoveryRecords,
): Result<ReviewReplacementGrant | null | undefined> {
  const dispositions = recovery.interruptions.filter((record) => record.payload.rootAttemptId === root.recordId)
  if (dispositions.length > 1)
    return fail([diagnostic('conflict', `Historical root ${root.recordId} has multiple interruption dispositions`)])
  if (dispositions.length === 0) return { ok: true, value: undefined }
  const disposition = dispositions[0]
  const grants = recovery.grants.filter(
    (grant) => grant.payload.rootAttemptId === root.recordId && grant.payload.dispositionId === disposition.recordId,
  )
  if (grants.length > 1)
    return fail([diagnostic('conflict', `Interrupted root ${root.recordId} has multiple replacement grants`)])
  if (grants.length === 0) return { ok: true, value: null }
  const grant = grants[0]
  const invalidGrant = validateGrant(grant, root, disposition, records)
  if (invalidGrant !== null) return fail([diagnostic('unbound', invalidGrant)])
  const replacements = recovery.replacements.filter(
    (replacement) => replacement.payload.replacement?.grantId === grant.recordId,
  )
  if (replacements.length > 1)
    return fail([diagnostic('conflict', `Replacement grant ${grant.recordId} is consumed more than once`)])
  if (replacements.length === 0) return { ok: true, value: grant }
  const invalidReplacement = validateReplacement(replacements[0], root, disposition, grant)
  if (invalidReplacement !== null) return fail([diagnostic('unbound', invalidReplacement)])
  return { ok: true, value: completedReview(records, replacements[0].recordId) ? undefined : null }
}

function stoppedRoots(
  records: readonly CanonicalRecord[],
  recovery: RecoveryRecords,
): Result<Array<ReviewReplacementGrant | null>> {
  const stopped: Array<ReviewReplacementGrant | null> = []
  for (const root of recovery.roots) {
    const stop = rootStop(root, records, recovery)
    if (!stop.ok) return stop
    if (stop.value !== undefined) stopped.push(stop.value)
  }
  return { ok: true, value: stopped }
}

export function readReviewRecovery(history: DecodedHistory): Result<ReviewRecovery> {
  const trusted = trustedRecoveryRecords(history)
  if (!trusted.ok) return trusted
  const recovery = classifyRecoveryRecords(trusted.value)
  const topology = validateRecoveryTopology(trusted.value, recovery)
  if (!topology.ok) return topology
  const stopped = stoppedRoots(trusted.value, recovery)
  if (!stopped.ok) return stopped
  if (stopped.value.length > 1 && stopped.value.some((grant) => grant !== null))
    return fail([diagnostic('ambiguous', 'More than one interrupted root requires recovery state')])
  const grant = stopped.value.find((candidate): candidate is ReviewReplacementGrant => candidate !== null) ?? null
  return {
    ok: true,
    value: {
      normalProgression: stopped.value.length === 0 ? 'eligible' : 'stopped',
      replacementGrant: grant,
    },
  }
}
