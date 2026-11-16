import { actionRequest, codePin, confirmPreparedAction, prepareRefusal } from './delivery-action.ts'
import type {
  FixActionResult,
  FixRequestInput,
  PreparedFix,
  RecordPublisher,
  ReviewAuthority,
  TargetResolver,
} from './fix-contract.ts'
import { failure, isRecordId, sameScopeAuthorityInputs, validPublishBinding, validScope } from './fix-contract.ts'
import { resolveFixOrigin } from './fix-origin.ts'
import { validateCorrectionOrigin } from './fix-origin-validation.ts'
import { admitReviewFix, preparedSubject, resolveFixTarget } from './fix-preparation.ts'
import { type OperatorRequestReservation, publishOperatorRequest, reserveOperatorRequest } from './fix-records.ts'
export type ReviewBoundBasis = Pick<PreparedFix, 'target' | 'causeContext' | 'subject'> & {
  authorityInputs: readonly string[]
}

/** Read and validate the current review-bound basis without creating a request. */
export async function prepareReviewBoundBasis(
  input: FixRequestInput & { reviewId: string },
  resolver: TargetResolver,
  workflow: ReviewAuthority,
  signal?: AbortSignal,
): Promise<FixActionResult<ReviewBoundBasis>> {
  const linkedAuthority = sameScopeAuthorityInputs(input)
  if (!linkedAuthority.ok) return linkedAuthority
  if (!validScope(input.scope) || !isRecordId(input.reviewId)) return failure('review-fix-input-invalid')
  if (signal?.aborted) return failure('fix-run-interrupted-cleanup-unproven')
  const resolved = await resolveFixTarget(input, resolver)
  if (!resolved.ok) return resolved
  const target = resolved.value
  if (input.candidateGitSHA && input.candidateGitSHA !== target.candidateGitSHA) return failure('fix-head-mismatch')
  if (!validPublishBinding(input.publishBinding, target)) return failure('fix-publish-binding-invalid')
  const authority = await admitReviewFix(target, input.cwd, input.reviewId, workflow)
  if (!authority.ok) return authority
  const origin = await resolveFixOrigin(input.uw, input.operations)
  if (!origin.ok) return origin
  const subject = preparedSubject(input, target)
  if (subject === null) return failure('prepare-action-unavailable')
  return {
    ok: true,
    value: { target, causeContext: origin.value, subject, authorityInputs: linkedAuthority.value },
  }
}

async function openReviewOwner(
  input: FixRequestInput,
  basis: ReviewBoundBasis,
  reservation: OperatorRequestReservation,
): Promise<FixActionResult<void>> {
  if (input.openOwner === undefined) return { ok: true, value: undefined }
  const { target, subject, causeContext } = basis
  const head = target.candidateGitSHA
  if (head === null) return failure('fix-head-mismatch')
  const pinned = codePin(target.repository, target.baseGitSHA ?? '', head, head)
  if (!pinned.ok) return failure('code-unobserved')
  const action = await confirmPreparedAction(
    input.operations,
    actionRequest({
      actionId: input.identity.nextRecordId('review-attempt'),
      purpose: 'correction',
      subject,
      code: pinned.code,
    }),
  )
  if (!action.ok) return failure(prepareRefusal(action.diagnostics))
  const validOrigin = validateCorrectionOrigin(action.value.inputs.manifest, causeContext)
  if (!validOrigin.ok) return validOrigin
  return input.openOwner({ target, manifest: action.value.inputs.manifest, reservation })
}

/** Review-driven fixes consume the already-confirmed decision unchanged: no intake or synthesis. */
export async function prepareReviewBoundFix(
  input: FixRequestInput & { reviewId: string },
  resolver: TargetResolver,
  publisher: RecordPublisher,
  workflow: ReviewAuthority,
  signal?: AbortSignal,
): Promise<FixActionResult<PreparedFix>> {
  const basis = await prepareReviewBoundBasis(input, resolver, workflow, signal)
  if (!basis.ok) return basis
  const { target, causeContext, subject, authorityInputs } = basis.value
  const reservation = reserveOperatorRequest(input.identity, target)
  input.executionFence?.enrollPublicationReservation(reservation.source)
  input.executionFence?.enrollPublicationReservation(reservation.request)
  if (input.executionFence !== undefined && input.openOwner === undefined)
    return failure('fix-owner-admission-unavailable')
  if (input.openOwner !== undefined) {
    const opened = await openReviewOwner(input, basis.value, reservation)
    if (!opened.ok) return opened
  }
  const published = await publishOperatorRequest(
    publisher,
    input.identity,
    target,
    {
      rawOperatorRequest: input.rawOperatorRequest,
      publishBinding: input.publishBinding,
      scope: input.scope,
      existingReviewId: input.reviewId,
      contextInputs: [input.reviewId, ...authorityInputs],
      originalSpec: causeContext.effective.own,
    },
    reservation,
    signal,
  )
  if (!published.ok) return published
  const { source, request } = published.value
  return {
    ok: true,
    value: {
      causeContext,
      target,
      requestId: request.recordId,
      inventoryId: input.reviewId,
      sourceContributionId: source.recordId,
      policy: input.policy ?? { version: 'baseline' },
      cwd: input.cwd,
      publishBinding: input.publishBinding,
      subject,
      batch: {
        operationId: input.identity.operationId,
        tasks: { context: 'review-bound correction has no intake batch', tasks: [] },
      },
    },
  }
}
