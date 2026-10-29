import { createTrustedDebtFiling } from './debt-filing-writer.ts'
import {
  actionRequest,
  codePin,
  confirmPreparedAction,
  correctionSubject,
  deliveryTask,
  prepareRefusal,
} from './delivery-action.ts'
import type {
  FixActionResult,
  FixRequestInput,
  FixTarget,
  PreparedFix,
  RecordPublisher,
  ReviewAuthority,
  TargetResolver,
} from './fix-contract.ts'
import {
  failure,
  isRecordId,
  sameScopeAuthorityInputs,
  targetMatches,
  validPublishBinding,
  validScope,
} from './fix-contract.ts'
import type { FixPolicy } from './fix-domain'
import { publish, publishOperatorRequest, record } from './fix-records.ts'

type StandalonePreparation = {
  target: FixTarget
  policy: FixPolicy
  authorityInputs: readonly string[]
}

function invalidNativeTasks(tasks: FixRequestInput['nativeTasks']): boolean {
  const names = new Set<string>()
  return tasks.some((task) => {
    const duplicate = names.has(task.name)
    names.add(task.name)
    return (
      duplicate ||
      !isRecordId(task.name) ||
      task.agent.trim().length === 0 ||
      task.task.trim().length === 0 ||
      task.solutionSpace.trim().length === 0
    )
  })
}

function preparedSubject(input: FixRequestInput, target: FixTarget) {
  const scope = { repository: target.repository, target: target.target }
  return correctionSubject(scope, input.uw, target.kind === 'pull-request' ? scope : null)
}

async function prepareStandaloneInputs(
  input: FixRequestInput,
  resolver: TargetResolver,
  workflow: ReviewAuthority | undefined,
  signal: AbortSignal | undefined,
): Promise<FixActionResult<StandalonePreparation>> {
  if (!validScope(input.scope)) return failure('fix-scope-invalid')
  const policy: FixPolicy = input.policy ?? { version: 'baseline' }
  if (signal?.aborted) return failure('fix-run-interrupted-cleanup-unproven')
  const resolved = await resolveFixTarget(input, resolver)
  if (!resolved.ok) return resolved
  const target = resolved.value
  if (input.candidateGitSHA && input.candidateGitSHA !== target.candidateGitSHA) return failure('fix-head-mismatch')
  if (!validPublishBinding(input.publishBinding, target)) return failure('fix-publish-binding-invalid')
  if (policy.version === 'evidence-v1' && policy.acceptanceRef.trim().length === 0)
    return failure('candidate-acceptance-required')
  const authority = await admitReviewFix(target, input.cwd, input.reviewId, workflow)
  if (!authority.ok) return authority
  if (signal?.aborted) return failure('fix-run-interrupted-cleanup-unproven')
  const authorityInputs = sameScopeAuthorityInputs(input)
  if (!authorityInputs.ok) return authorityInputs
  return { ok: true, value: { target, policy, authorityInputs: authorityInputs.value } }
}

/** Refuses targetless, ambiguous, closed, and mismatched context before any durable write. */
export async function resolveFixTarget(
  input: Pick<FixRequestInput, 'reference' | 'contextTarget'>,
  resolver: TargetResolver,
): Promise<FixActionResult<FixTarget>> {
  const explicit = input.reference?.trim()
  const explicitTarget = explicit ? await resolver.resolveExplicit(explicit) : null
  const contextTarget = input.contextTarget ?? (explicit ? null : await resolver.resolveContext())
  if (!explicitTarget && !contextTarget) return failure('fix-target-required')
  if (explicit && !explicitTarget) return failure('fix-target-not-found')
  if (explicitTarget && contextTarget && !targetMatches(explicitTarget, contextTarget))
    return failure('fix-target-ambiguous')
  const target = explicitTarget ?? contextTarget
  if (!target) return failure('fix-target-required')
  if (target.state !== 'open') return failure('fix-target-closed')
  if (target.candidateGitSHA === null) return failure('fix-target-head-unknown')
  return { ok: true, value: target }
}

/** Every PR correction re-reads workflow authority; a stopped or CI-red PR cannot be bypassed by standalone intake. */
export async function admitReviewFix(
  target: FixTarget,
  cwd: string,
  reviewId: string | undefined,
  workflow: ReviewAuthority | undefined,
): Promise<FixActionResult<void>> {
  if (target.kind !== 'pull-request') return { ok: true, value: undefined }
  if (!workflow) return failure('review-fix-authority-unavailable')
  const next = await workflow.nextReviewStep(cwd, target.number, { reviewing: true })
  if (next.reason === 'ci-failed') return failure('ci-failed-requires-ci-correction')
  if (next.action === 'stop') return failure(`review-fix-not-authorized:${next.action}`)
  if (reviewId !== undefined && next.action !== 'fix') return failure(`review-fix-not-authorized:${next.action}`)
  return { ok: true, value: undefined }
}

/** Writes the operator contribution, landing:false request, and correction inventory before native dispatch. */
export async function prepareStandaloneFix(
  input: FixRequestInput,
  resolver: TargetResolver,
  publisher: RecordPublisher,
  workflow?: ReviewAuthority,
  signal?: AbortSignal,
): Promise<FixActionResult<PreparedFix>> {
  const base = await prepareStandaloneInputs(input, resolver, workflow, signal)
  if (!base.ok) return base
  const { target, policy, authorityInputs } = base.value
  if (input.nativeTasks.length === 0) return failure('fix-intake-tasks-required')
  if (invalidNativeTasks(input.nativeTasks)) return failure('fix-intake-tasks-invalid')

  const published = await publishOperatorRequest(
    publisher,
    input.identity,
    target,
    {
      rawOperatorRequest: input.rawOperatorRequest,
      publishBinding: input.publishBinding,
      scope: input.scope,
      existingReviewId: input.reviewId ?? null,
      contextInputs: authorityInputs,
    },
    signal,
  )
  if (!published.ok) return published
  if (signal?.aborted) return failure('fix-run-interrupted-cleanup-unproven')
  const { source, request } = published.value

  const inventoryId = input.identity.nextRecordId('review-attempt')
  const head = target.candidateGitSHA
  if (head === null) return failure('fix-head-mismatch')
  const pinned = codePin(target.repository, target.baseGitSHA ?? '', head, head)
  if (!pinned.ok) return failure('code-unobserved')
  const subject = preparedSubject(input, target)
  if (subject === null) return failure('prepare-action-unavailable')
  const preparedAction = await confirmPreparedAction(
    input.operations,
    actionRequest({
      actionId: inventoryId,
      purpose: 'correction',
      subject,
      code: pinned.code,
    }),
  )
  if (!preparedAction.ok) return failure(prepareRefusal(preparedAction.diagnostics))
  const fingerprint = preparedAction.value.inputs.fingerprint
  const tasks = input.nativeTasks.map((task) =>
    deliveryTask({
      name: task.name,
      agent: task.agent,
      procedure: task.task,
      solutionSpace: task.solutionSpace,
      prepared: preparedAction.value,
      tools: task.tools,
      proofEvidence: task.proofEvidence,
    }),
  )
  const inventory = record(
    input.identity,
    target,
    'review-attempt',
    {
      rootAttemptId: inventoryId,
      candidateGitSHA: head,
      inputFormat: 'omp-build:review-input/4',
      input: fingerprint,
      actionInputDigest: fingerprint,
      stage: 'initial',
      purpose: 'correction',
      requestId: request.recordId,
      policy,
      slots: tasks.map((task) => ({
        slotId: task.name,
        phase: 'intake',
        role: task.agent,
        chunk: null,
        required: true,
        output: 'findings',
        classId: null,
        sourceFindingIds: [],
        action: { actionId: task.action.snapshot.actionId, inputs: task.action.inputs },
      })),
    },
    [request.recordId],
    inventoryId,
  )
  const savedInventory = await publish(publisher, inventory)
  if (!savedInventory.ok) return savedInventory

  return {
    ok: true,
    value: {
      target,
      requestId: request.recordId,
      inventoryId: inventory.recordId,
      sourceContributionId: source.recordId,
      policy,
      cwd: input.cwd,
      publishBinding: input.publishBinding,
      debtFiling: input.debtFiling ?? createTrustedDebtFiling(),
      subject,
      batch: {
        operationId: input.identity.operationId,
        tasks: {
          context: 'omp-build correction action. Read only the procedure and the index named on the task.',
          tasks,
        },
      },
    },
  }
}

/** Review-driven fixes consume the already-confirmed decision unchanged: no intake or synthesis. */
export async function prepareReviewBoundFix(
  input: FixRequestInput & { reviewId: string },
  resolver: TargetResolver,
  publisher: RecordPublisher,
  workflow: ReviewAuthority,
  signal?: AbortSignal,
): Promise<FixActionResult<PreparedFix>> {
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
  const published = await publishOperatorRequest(
    publisher,
    input.identity,
    target,
    {
      rawOperatorRequest: input.rawOperatorRequest,
      publishBinding: input.publishBinding,
      scope: input.scope,
      existingReviewId: input.reviewId,
      contextInputs: [input.reviewId, ...linkedAuthority.value],
    },
    signal,
  )
  if (!published.ok) return published
  const { source, request } = published.value
  const subject = preparedSubject(input, target)
  if (subject === null) return failure('prepare-action-unavailable')
  return {
    ok: true,
    value: {
      target,
      requestId: request.recordId,
      inventoryId: input.reviewId,
      sourceContributionId: source.recordId,
      policy: input.policy ?? { version: 'baseline' },
      cwd: input.cwd,
      publishBinding: input.publishBinding,
      debtFiling: input.debtFiling ?? createTrustedDebtFiling(),
      subject,
      batch: {
        operationId: input.identity.operationId,
        tasks: { context: 'review-bound correction has no intake batch', tasks: [] },
      },
    },
  }
}
