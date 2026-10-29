import type { CanonicalRecord, DecodedHistory, GitHubOptions } from '../dist/contracts.js'
import { validateReviewDecisionBindings } from '../dist/contracts.js'
import { validateReviewInput } from '../skills/feature/workflow-review-input.js'
import type {
  FixActionResult,
  FixIdentity,
  FixRecord,
  FixTarget,
  RecordPublisher,
  TargetResolver,
} from './fix-contract.ts'
import type { DefaultFixEntry } from './fix-entry-input.ts'
import { fail } from './fix-entry-target-core.ts'
import type { DefaultFixRequest } from './fix-execution-policy.ts'
import { runReviewBoundFixWorkflow } from './fix-execution-runner.ts'
import { confirmFixContinuation } from './fix-mandate-authority.ts'
import type { FixWorkflowRuntime } from './fix-native-dispatch.ts'
import { prepareReviewBoundFix } from './fix-preparation.ts'
export function confirmedRecord(
  history: DecodedHistory,
  recordId: string,
  kind: CanonicalRecord['kind'],
): CanonicalRecord | null {
  const operation = history.operations.find(
    (entry) => entry.status === 'complete' && entry.recordId === recordId && entry.kind === kind,
  )
  return operation?.record ?? null
}
export function boundDecision(
  history: DecodedHistory,
  reviewId: string,
  candidate: string,
): Extract<CanonicalRecord, { kind: 'decision' }> | null {
  const review = confirmedRecord(history, reviewId, 'review')
  if (review?.kind !== 'review' || review.payload.candidateGitSHA !== candidate) return null
  const decision = confirmedRecord(history, review.payload.decisionId, 'decision')
  return decision?.kind === 'decision' ? decision : null
}

export function captureConfirmedFixRequest(
  publisher: RecordPublisher,
  capture: (request: Extract<FixRecord, { kind: 'fix-request' }>) => void,
): RecordPublisher {
  return {
    publish: async (record) => {
      const saved = await publisher.publish(record)
      if (saved.ok && record.kind === 'fix-request') capture(record)
      return saved
    },
  }
}

async function confirmReviewBoundContinuation(
  review: Extract<CanonicalRecord, { kind: 'review' }>,
  target: FixTarget,
  options: GitHubOptions,
  readHistory: () => Promise<DecodedHistory>,
  branch: string | null,
  base: string,
  uw: DefaultFixEntry['uw'],
  boundRecordId: string,
  requiredFeatureMandate: DefaultFixEntry['requiredFeatureMandate'],
  trustedLiveRequest: Extract<FixRecord, { kind: 'fix-request' }>,
): Promise<FixActionResult<void>> {
  const history = await readHistory()
  if (!history.source.complete) return fail('review-history-or-head-incomplete')
  if (!validateReviewDecisionBindings(review, history).ok) return fail('review-decision-bindings-invalid')
  return confirmFixContinuation({
    target,
    options,
    readHistory: async () => history,
    branch,
    base,
    uw,
    boundRecordId,
    requiredFeatureMandate,
    trustedLiveRequest,
  })
}

export async function runReviewBoundDefaultFix(
  input: DefaultFixEntry,
  id: FixIdentity,
  runtime: FixWorkflowRuntime,
  target: FixTarget,
  resolver: TargetResolver,
  publisher: RecordPublisher,
  request: DefaultFixRequest,
  readHistory: () => Promise<DecodedHistory>,
  reviewId: string,
  github: GitHubOptions,
  mandate: { recordId: string },
): Promise<FixActionResult<FixRecord>> {
  if (target.kind !== 'pull-request') return fail('review-fix-requires-pull-request')
  try {
    const history = await readHistory()
    if (!history.source.complete || target.candidateGitSHA === null) return fail('review-history-or-head-incomplete')
    const decision = boundDecision(history, reviewId, target.candidateGitSHA)
    if (decision === null) return fail('review-decision-unconfirmed-or-stale')
    const reviewRecord = confirmedRecord(history, reviewId, 'review')
    if (reviewRecord?.kind !== 'review') return fail('review-decision-unconfirmed-or-stale')
    if (!validateReviewDecisionBindings(reviewRecord, history).ok) return fail('review-decision-bindings-invalid')
    const freshInput = await validateReviewInput(
      input.cwd,
      target.number,
      target.candidateGitSHA,
      reviewRecord.payload.input,
      input.pluginPin === undefined ? {} : { pluginPin: input.pluginPin },
    )
    if (!freshInput.ok) return fail(`review-input-stale:${freshInput.reason}`)
    let trustedLiveRequest: Extract<FixRecord, { kind: 'fix-request' }> | undefined
    const prepared = await prepareReviewBoundFix(
      {
        ...request,
        reviewId,
        candidateGitSHA: target.candidateGitSHA,
        policy: decision.payload.judgment.policy,
        nativeTasks: [],
      },
      resolver,
      captureConfirmedFixRequest(publisher, (record) => {
        trustedLiveRequest = record
      }),
      input.workflow,
      runtime.signal,
    )
    if (!prepared.ok) return prepared
    const confirmedRequest = trustedLiveRequest
    if (confirmedRequest === undefined) return fail('fix-request-unconfirmed')
    runtime.bindContinuation?.(() =>
      confirmReviewBoundContinuation(
        reviewRecord,
        target,
        github,
        readHistory,
        request.publishBinding.localBranch,
        request.publishBinding.defaultBranch,
        input.uw,
        mandate.recordId,
        input.requiredFeatureMandate,
        confirmedRequest,
      ),
    )
    return runReviewBoundFixWorkflow(
      prepared.value,
      decision,
      { native: input.native, publisher, runtime, readHistory },
      id,
      input.debtEvidence,
    )
  } catch (error) {
    return fail(`review-bound-fix-read-failed:${error instanceof Error ? error.message : String(error)}`)
  }
}
