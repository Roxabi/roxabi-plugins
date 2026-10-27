import { buildRecord, type RecordDraft } from './record-construction.ts'
import { diagnostic, fail } from './record-diagnostics.ts'
import { REVIEW_INPUT_FORMAT } from './record-format.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Result } from './result.ts'
import { isInitialPullRequestReviewInventory } from './review-schema.ts'

type ReviewRoot = Extract<CanonicalRecord, { kind: 'review-attempt' }>
type WorkflowBinding = Extract<CanonicalRecord, { kind: 'workflow-binding' }>
type ReviewInterruption = Extract<CanonicalRecord, { kind: 'review-interruption' }>
type ReviewReplacementGrant = Extract<CanonicalRecord, { kind: 'review-replacement-grant' }>

export function reviewInterruptionRecordId(rootAttemptId: string): string {
  return `review-interruption-${rootAttemptId}`
}

export function reviewReplacementGrantRecordId(dispositionId: string): string {
  return `review-replacement-grant-${dispositionId}`
}

export function reviewReplacementInventoryRecordId(grantId: string): string {
  return `review-replacement-inventory-${grantId}`
}

/** Build the deterministic review-interruption draft for one historical root. */
export function buildReviewInterruptionRecord(input: {
  root: ReviewRoot
  historicalBinding: WorkflowBinding
  runId: string
}): Result<ReviewInterruption> {
  const recordId = reviewInterruptionRecordId(input.root.recordId)
  const draft = {
    version: 1 as const,
    repository: input.root.repository,
    target: input.root.target,
    recordId,
    runId: input.runId,
    operationId: `op-${recordId}`,
    kind: 'review-interruption' as const,
    payload: {
      rootAttemptId: input.root.recordId,
      historicalBinding: {
        scope: { repository: input.historicalBinding.repository, target: input.historicalBinding.target },
        recordId: input.historicalBinding.recordId,
        kind: 'workflow-binding' as const,
      },
    },
  } satisfies RecordDraft
  return buildRecord(draft) as Result<ReviewInterruption>
}

/** Build the deterministic one-use replacement grant for one disposition. */
export function buildReviewReplacementGrantRecord(input: {
  root: ReviewRoot
  disposition: ReviewInterruption
  binding: WorkflowBinding
  candidateGitSHA: string
  digest: string
  runId: string
}): Result<ReviewReplacementGrant> {
  const recordId = reviewReplacementGrantRecordId(input.disposition.recordId)
  const draft = {
    version: 1 as const,
    repository: input.root.repository,
    target: input.root.target,
    recordId,
    runId: input.runId,
    operationId: `op-${recordId}`,
    kind: 'review-replacement-grant' as const,
    payload: {
      rootAttemptId: input.root.recordId,
      dispositionId: input.disposition.recordId,
      candidateGitSHA: input.candidateGitSHA,
      inputFormat: REVIEW_INPUT_FORMAT,
      input: input.digest,
      binding: {
        scope: { repository: input.binding.repository, target: input.binding.target },
        recordId: input.binding.recordId,
        kind: 'workflow-binding' as const,
      },
    },
  } satisfies RecordDraft
  return buildRecord(draft) as Result<ReviewReplacementGrant>
}

/** Build the deterministic linked replacement inventory that consumes one grant. */
export function buildReviewReplacementInventoryRecord(input: {
  grant: ReviewReplacementGrant
  template: ReviewRoot
  runId: string
}): Result<ReviewRoot> {
  if (!isInitialPullRequestReviewInventory(input.template.payload))
    return fail([diagnostic('unbound', 'Replacement inventory template must be an initial pull-request review')])
  const template = input.template.payload
  const recordId = reviewReplacementInventoryRecordId(input.grant.recordId)
  const draft = {
    version: 1 as const,
    repository: input.template.repository,
    target: input.template.target,
    recordId,
    runId: input.runId,
    operationId: `op-${recordId}`,
    kind: 'review-attempt' as const,
    payload: {
      ...template,
      rootAttemptId: recordId,
      candidateGitSHA: input.grant.payload.candidateGitSHA,
      inputFormat: REVIEW_INPUT_FORMAT,
      input: input.grant.payload.input,
      stage: 'initial' as const,
      purpose: 'review' as const,
      subject: { kind: 'pull-request' as const },
      replacement: {
        rootAttemptId: input.grant.payload.rootAttemptId,
        dispositionId: input.grant.payload.dispositionId,
        grantId: input.grant.recordId,
      },
    },
  } satisfies RecordDraft
  return buildRecord(draft) as Result<ReviewRoot>
}
