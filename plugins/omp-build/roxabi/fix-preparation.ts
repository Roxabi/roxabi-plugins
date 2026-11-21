import type { ActionInputManifest } from '../engine/action-input-schema.ts'
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
import { resolveFixOrigin } from './fix-origin.ts'
import { validateCorrectionOrigin } from './fix-origin-validation.ts'
import {
  type OperatorRequestReservation,
  publish,
  publishOperatorRequest,
  record,
  reserveOperatorRequest,
} from './fix-records.ts'

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
function validateNativeTasks(tasks: FixRequestInput['nativeTasks']): FixActionResult<void> {
  if (tasks.length === 0) return failure('fix-intake-tasks-required')
  if (invalidNativeTasks(tasks)) return failure('fix-intake-tasks-invalid')
  return { ok: true, value: undefined }
}

export function preparedSubject(input: FixRequestInput, target: FixTarget) {
  const scope = { repository: target.repository, target: target.target }
  return correctionSubject(scope, input.uw, scope)
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

function validateResolvedTarget(target: FixTarget | null): FixActionResult<FixTarget> {
  if (!target) return failure('fix-target-required')
  if (target.state !== 'open') return failure('fix-target-closed')
  if (target.candidateGitSHA === null) return failure('fix-target-head-unknown')
  return { ok: true, value: target }
}

/** Refuses targetless, ambiguous, closed, and mismatched context before any durable write. */
export async function resolveFixTarget(
  input: Pick<FixRequestInput, 'reference' | 'contextTarget'>,
  resolver: TargetResolver,
): Promise<FixActionResult<FixTarget>> {
  const explicit = input.reference?.trim()
  const resolvedExplicit = explicit ? await resolver.resolveExplicit(explicit) : null
  if (resolvedExplicit !== null && !resolvedExplicit.ok) return resolvedExplicit
  const explicitTarget = resolvedExplicit?.value ?? null
  const contextTarget = input.contextTarget ?? (explicit ? null : await resolver.resolveContext())
  if (!explicitTarget && !contextTarget) return failure('fix-target-required')
  if (explicit && !explicitTarget) return failure('fix-target-not-found')
  if (explicitTarget && contextTarget && !targetMatches(explicitTarget, contextTarget))
    return failure('fix-target-ambiguous')
  return validateResolvedTarget(explicitTarget ?? contextTarget)
}

/** Every PR correction re-reads workflow authority; a stopped or CI-red PR cannot be bypassed by standalone intake. */
export async function admitReviewFix(
  target: FixTarget,
  cwd: string,
  reviewId: string | undefined,
  workflow: ReviewAuthority | undefined,
): Promise<FixActionResult<void>> {
  if (!workflow) return failure('review-fix-authority-unavailable')
  const next = await workflow.nextReviewStep(cwd, target.number, { reviewing: true })
  if (next.reason === 'ci-failed') return failure('ci-failed-requires-ci-correction')
  if (next.action === 'stop') return failure(`review-fix-not-authorized:${next.action}`)
  if (reviewId !== undefined && next.action !== 'fix') return failure(`review-fix-not-authorized:${next.action}`)
  return { ok: true, value: undefined }
}

async function reserveStandaloneOwner(
  input: FixRequestInput,
  target: FixTarget,
  manifest: ActionInputManifest,
): Promise<FixActionResult<OperatorRequestReservation>> {
  const reservation = reserveOperatorRequest(input.identity, target)
  input.executionFence?.enrollPublicationReservation(reservation.source)
  input.executionFence?.enrollPublicationReservation(reservation.request)
  if (input.executionFence !== undefined && input.openOwner === undefined)
    return failure('fix-owner-admission-unavailable')
  if (input.openOwner !== undefined) {
    const opened = await input.openOwner({ target, manifest, reservation })
    if (!opened.ok) return opened
  }
  return { ok: true, value: reservation }
}

/** Prepares native intake and validates its origin before publishing the source, request, and inventory. */
export async function prepareStandaloneFix(
  input: FixRequestInput,
  resolver: TargetResolver,
  publisher: RecordPublisher,
  workflow?: ReviewAuthority,
  signal?: AbortSignal,
): Promise<FixActionResult<PreparedFix>> {
  const base = await prepareStandaloneInputs(input, resolver, workflow, signal)
  if (!base.ok) return base
  if (signal?.aborted) return failure('fix-run-interrupted-cleanup-unproven')
  const { target, policy, authorityInputs } = base.value
  const validTasks = validateNativeTasks(input.nativeTasks)
  if (!validTasks.ok) return validTasks
  const origin = await resolveFixOrigin(input.uw, input.operations)
  if (!origin.ok) return origin

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
  const validOrigin = validateCorrectionOrigin(preparedAction.value.inputs.manifest, origin.value)
  if (!validOrigin.ok) return validOrigin
  const reserved = await reserveStandaloneOwner(input, target, preparedAction.value.inputs.manifest)
  if (!reserved.ok) return reserved
  const reservation = reserved.value
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
      originalSpec: origin.value.effective.own,
    },
    reservation,
    signal,
  )
  if (!published.ok) return published
  if (signal?.aborted) return failure('fix-run-interrupted-cleanup-unproven')
  const { source, request } = published.value

  const fingerprint = preparedAction.value.inputs.fingerprint
  const tasks = input.nativeTasks.map((task) =>
    deliveryTask({
      name: task.name,
      agent: task.agent,
      procedure: task.task,
      solutionSpace: task.solutionSpace,
      prepared: preparedAction.value,
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
  input.executionFence?.enrollPublicationReservation({
    scope: { repository: inventory.repository, target: inventory.target },
    kind: inventory.kind,
    runId: inventory.runId,
    operationId: inventory.operationId,
    recordId: inventory.recordId,
  })
  const savedInventory = await publish(publisher, inventory)
  if (!savedInventory.ok) return savedInventory

  return {
    ok: true,
    value: {
      causeContext: origin.value,
      target,
      requestId: request.recordId,
      inventoryId: inventory.recordId,
      sourceContributionId: source.recordId,
      policy,
      cwd: input.cwd,
      publishBinding: input.publishBinding,
      subject,
      batch: {
        operationId: input.identity.operationId,
        tasks: {
          context:
            'omp-build correction action. Follow the procedure and role profile; use the indexed snapshot for UW data and normative references.',
          tasks,
        },
      },
    },
  }
}
