import type { DecodedHistory } from './history-schema.ts'
import { diagnostic } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Result } from './result.ts'
import { accounted } from './review-context-authentication.ts'
import { validateDecisionBindings } from './review-decision.ts'
import { recordsOf } from './workflow-control.ts'

type FixRequest = Extract<CanonicalRecord, { kind: 'fix-request' }>
type Decision = Extract<CanonicalRecord, { kind: 'decision' }>
const failure = (): Result<never> => ({
  ok: false,
  diagnostics: [diagnostic('record-unreadable', 'Correction historical basis is missing or inconsistent')],
})
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
function originalDecisionMatches(
  history: DecodedHistory,
  fix: FixRequest,
  decision: Decision,
  candidate: string,
): boolean {
  const records = recordsOf(history)
  const originals = records.filter(
    (r) => r.kind === 'contribution' && r.recordId === decision.payload.originalContributionId,
  )
  const original = originals[0]
  if (
    originals.length !== 1 ||
    original?.kind !== 'contribution' ||
    original.payload.inventoryId === null ||
    !accounted(history, original)
  )
    return false
  const inventories = records.filter((r) => r.kind === 'review-attempt' && r.recordId === original.payload.inventoryId)
  const inventory = inventories[0]
  if (
    inventories.length !== 1 ||
    inventory?.kind !== 'review-attempt' ||
    !accounted(history, inventory) ||
    inventory.payload.candidateGitSHA !== candidate
  )
    return false
  if (fix.payload.existingReviewId !== null) {
    const reviews = records.filter((r) => r.kind === 'review' && r.recordId === fix.payload.existingReviewId)
    const review = reviews[0]
    return (
      reviews.length === 1 &&
      review?.kind === 'review' &&
      accounted(history, review) &&
      fix.inputs.includes(review.recordId) &&
      review.payload.decisionId === decision.recordId &&
      review.payload.inventoryIds.includes(inventory.recordId)
    )
  }
  const roots = records.filter((r) => r.kind === 'review-attempt' && r.recordId === inventory.payload.rootAttemptId)
  const root = roots[0]
  return (
    roots.length === 1 &&
    root?.kind === 'review-attempt' &&
    accounted(history, root) &&
    root.payload.stage === 'initial' &&
    root.payload.purpose === 'correction' &&
    root.payload.requestId === fix.recordId
  )
}

function operatorBasis(
  history: DecodedHistory,
  fix: FixRequest,
): { originalCandidate: string; expectedRemoteHead: string; branch: string; base: string } | null {
  const matches = recordsOf(history).filter(
    (r) => r.kind === 'contribution' && r.recordId === fix.payload.requestContributionId,
  )
  const original = matches[0]
  if (
    matches.length !== 1 ||
    original?.kind !== 'contribution' ||
    !accounted(history, original) ||
    original.payload.content !== 'operator-request' ||
    original.payload.inventoryId !== null ||
    original.payload.host.origin !== 'operator' ||
    original.payload.host.phase !== 'fix' ||
    original.payload.host.role !== 'operator' ||
    original.payload.rawAttempts.length !== 1 ||
    !fix.inputs.includes(original.recordId)
  )
    return null
  const raw = object(original.payload.rawAttempts[0]?.raw)
  const binding = object(raw?.publishBinding)
  const observed = object(binding?.observed)
  const pr = object(observed?.pr)
  const candidate = raw?.candidateGitSHA
  if (
    typeof candidate !== 'string' ||
    !/^[0-9a-f]{40}$/i.test(candidate) ||
    binding?.localHead !== candidate ||
    binding.expectedRemoteSHA !== candidate ||
    pr?.headRefOid !== candidate ||
    typeof binding.localBranch !== 'string' ||
    binding.localBranch.length === 0 ||
    pr.headRefName !== binding.localBranch ||
    binding.destinationRef !== `refs/heads/${binding.localBranch}` ||
    binding.publicationRepository !== pr.headRepository ||
    observed?.localRef !== binding.destinationRef ||
    observed.localHead !== candidate ||
    observed.remoteRepository !== binding.publicationRepository ||
    observed.target !== fix.target ||
    observed.baseRepository !== fix.repository ||
    typeof pr.baseRefName !== 'string' ||
    pr.baseRefName.length === 0
  )
    return null
  return {
    originalCandidate: candidate,
    expectedRemoteHead: candidate,
    branch: binding.localBranch,
    base: pr.baseRefName,
  }
}

/** Authenticate the request-to-decision and original host-observed H1 anchor. */
export function resolveCorrectionRequestBasis(
  history: DecodedHistory,
  fix: FixRequest,
  decision: Decision,
): Result<{
  originalCandidate: string
  expectedRemoteHead: string
  branch: string
  base: string
}> {
  if (
    !accounted(history, fix) ||
    !accounted(history, decision) ||
    !validateDecisionBindings(decision, history).admissible
  )
    return failure()
  const basis = operatorBasis(history, fix)
  return basis !== null && originalDecisionMatches(history, fix, decision, basis.originalCandidate)
    ? { ok: true, value: basis }
    : failure()
}
