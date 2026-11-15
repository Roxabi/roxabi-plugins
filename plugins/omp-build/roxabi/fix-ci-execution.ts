import type { NativeBatchResult, NativeTask } from '../omp/review-runtime/contracts.ts'
import { actionRequest, codePin, confirmPreparedAction, deliveryTask, uwSubject } from './delivery-action.ts'
import { type ExpectedAttributedCiCorrectionInput, reAdmitAttributedCiCorrection } from './fix-ci-admission.ts'
import { type CiCorrectionProduct, synthesizeCiCorrection } from './fix-ci-synthesis.ts'
import type { FixActionResult, FixRecord, PreparedFix } from './fix-contract.ts'
import { failure, validPublishBinding } from './fix-contract.ts'
import { assessFixIntake, publishNativeContributions, taskSlot } from './fix-contributions-native.ts'
import { capturePreparedIntake, persistCapturedCauseDispositions } from './fix-disposition-capture.ts'
import type { FixPolicy } from './fix-domain'
import { admitDecisionExecution, executionCatalogues } from './fix-execution-policy.ts'
import { executeDecision } from './fix-execution-runner.ts'
import { retainFailedOutput } from './fix-execution-support.ts'
import { confirmFixContinuation } from './fix-mandate-authority.ts'
import type { AttributedCiCorrectionInput, CiCorrectionBound } from './fix-mandate-types.ts'
import { actionTask, dispatchNativeBatch } from './fix-native-dispatch.ts'
import { resolveFixOrigin } from './fix-origin.ts'
import { validateCorrectionOrigin } from './fix-origin-validation.ts'
import { publish, publishOperatorRequest, record } from './fix-records.ts'
import { nativeFixProfileByAction } from './native-review-profiles'
import type { RecordInputRef } from './uw-action-contract.ts'

type AttributedCorrection = Extract<CiCorrectionBound, { status: 'attributed-correction' }>
type CiCorrectionPreparation = { prepared: PreparedFix; intakeTask: NativeTask; attribution: RecordInputRef }
type PreservedIntake = { result: NativeBatchResult; records: FixRecord[] }
function isFixRequest(record: FixRecord): record is Extract<FixRecord, { kind: 'fix-request' }> {
  return record.kind === 'fix-request'
}

async function validateSynthesisHistory(
  product: CiCorrectionProduct,
  decision: FixRecord,
): Promise<FixActionResult<void>> {
  try {
    const history = await product.readHistory()
    if (!history.source.complete) return failure('correction-synthesis-history-incomplete')
    if (decision.kind !== 'decision') return failure('ci-correction-decision-invalid')
    const catalogues = await executionCatalogues(history, product.github)
    if (!catalogues.ok) return catalogues
    return admitDecisionExecution(decision, history, catalogues.value)
  } catch (error) {
    return failure(`correction-synthesis-history-unreadable:${error instanceof Error ? error.message : String(error)}`)
  }
}

async function prepareCiCorrection(
  input: AttributedCiCorrectionInput,
  product: CiCorrectionProduct,
  admitted: AttributedCorrection,
): Promise<FixActionResult<CiCorrectionPreparation>> {
  const origin = await resolveFixOrigin(admitted.uw.ownSpec.ref.uw, product.runtime.uw)
  if (!origin.ok) return origin
  const causeContext = origin.value
  const intakeDraft = actionTask(
    'ci-correction-intake',
    nativeFixProfileByAction.intake,
    'Inspect only the attributed CI failure named by the index. Return structured findings. Do not edit, commit, push, arm, or land.',
    'bounded attributed CI evidence intake',
  )
  const policy: FixPolicy = { version: 'baseline' }
  const inventoryId = product.identity.nextRecordId('review-attempt')
  const head = admitted.candidateGitSHA
  if (head === null || input.target.baseGitSHA === null) return failure('prepare-action-unavailable')
  if (!validPublishBinding(product.publishBinding, input.target) || product.publishBinding.localHead !== head)
    return failure('fix-publish-binding-invalid')
  const pinned = codePin(input.target.repository, input.target.baseGitSHA, head, head)
  if (!pinned.ok) return failure('code-unobserved')
  const pullRequest = { repository: input.target.repository, target: input.target.target }
  const attribution: RecordInputRef = {
    source: 'record',
    record: { scope: pullRequest, kind: 'action-receipt', recordId: admitted.attributionRecordId },
    selector: '/payload',
    digest: admitted.attributionDigest,
  }
  const preparedAction = await confirmPreparedAction(
    product.runtime.uw,
    actionRequest({
      actionId: inventoryId,
      purpose: 'correction',
      subject: uwSubject(admitted.uw.ownSpec.ref.uw, pullRequest),
      code: pinned.code,
      stageSources: [attribution],
    }),
  )
  if (!preparedAction.ok) return failure('prepare-action-unavailable')
  const originCheck = validateCorrectionOrigin(preparedAction.value.inputs.manifest, causeContext)
  if (!originCheck.ok) return originCheck
  const published = await publishOperatorRequest(
    product.publisher,
    product.identity,
    input.target,
    {
      rawOperatorRequest: {
        ciCorrection: {
          attributionRecordId: admitted.attributionRecordId,
          failedChecks: [...admitted.failedChecks],
          candidateGitSHA: head,
        },
      },
      publishBinding: product.publishBinding,
      scope: admitted.uw.ownSpec.snapshot.raw.body,
      existingReviewId: null,
      contextInputs: [],
      originalSpec: causeContext.effective.own,
    },
    product.runtime.signal,
  )
  if (!published.ok) return published
  const { source, request } = published.value
  const intakeTask = deliveryTask({
    name: intakeDraft.name,
    agent: intakeDraft.agent,
    procedure: intakeDraft.task,
    solutionSpace: intakeDraft.solutionSpace,
    prepared: preparedAction.value,
    proofEvidence: intakeDraft.proofEvidence,
  })
  const prepared: PreparedFix = {
    causeContext,
    target: input.target,
    requestId: request.recordId,
    inventoryId,
    sourceContributionId: source.recordId,
    policy,
    cwd: input.cwd,
    publishBinding: product.publishBinding,
    subject: uwSubject(admitted.uw.ownSpec.ref.uw, pullRequest),
    batch: {
      operationId: product.identity.operationId,
      tasks: {
        context:
          'omp-build correction action. Follow the procedure and role profile; use the indexed snapshot for UW data and normative references.',
        tasks: [intakeTask],
      },
    },
  }
  const inventory = record(
    product.identity,
    input.target,
    'review-attempt',
    {
      rootAttemptId: prepared.inventoryId,
      candidateGitSHA: input.target.candidateGitSHA,
      inputFormat: 'omp-build:review-input/4',
      input: preparedAction.value.inputs.fingerprint,
      actionInputDigest: preparedAction.value.inputs.fingerprint,
      stage: 'initial',
      purpose: 'correction',
      requestId: request.recordId,
      policy,
      slots: [taskSlot(intakeTask, 'intake', 'findings')],
    },
    [request.recordId],
    prepared.inventoryId,
  )
  const savedInventory = await publish(product.publisher, inventory)
  if (!savedInventory.ok) return savedInventory
  if (isFixRequest(request)) {
    product.runtime.bindContinuation?.(() =>
      confirmFixContinuation({
        target: input.target,
        options: input.options,
        readHistory: input.readHistory,
        branch: input.branch,
        base: input.base,
        uw: input.uw,
        boundRecordId: admitted.mandateRecordId,
        trustedLiveRequest: request,
      }),
    )
  }
  return { ok: true, value: { prepared, intakeTask, attribution } }
}

async function dispatchCiCorrectionIntake(
  prepared: PreparedFix,
  intakeTask: NativeTask,
  product: CiCorrectionProduct,
): Promise<FixActionResult<PreservedIntake>> {
  return dispatchNativeBatch<PreservedIntake>(
    product.native,
    prepared.batch,
    product.runtime,
    (result) =>
      publishNativeContributions(
        prepared,
        product.identity,
        product.publisher,
        prepared.inventoryId,
        [intakeTask],
        'intake',
        'findings',
        [prepared.inventoryId],
        result,
      ).then((contributions) =>
        contributions.ok ? { ok: true, value: { result, records: contributions.value } } : contributions,
      ),
    true,
  )
}

export async function runAdmittedCiCorrection(
  input: ExpectedAttributedCiCorrectionInput,
  product: CiCorrectionProduct,
): Promise<FixActionResult<FixRecord>> {
  const admitted = await reAdmitAttributedCiCorrection(input)
  if (!admitted.ok) return admitted
  if (admitted.value.status !== 'attributed-correction') return failure(`ci-correction-${admitted.value.status}`)
  const preparation = await prepareCiCorrection(input, product, admitted.value)
  if (!preparation.ok) return preparation
  const intakeCapture = capturePreparedIntake(preparation.value.prepared)
  if (!intakeCapture.ok) return intakeCapture
  const preservedIntake = await dispatchCiCorrectionIntake(
    preparation.value.prepared,
    preparation.value.intakeTask,
    product,
  )
  if (!preservedIntake.ok) return preservedIntake
  const intake = assessFixIntake(
    preparation.value.prepared,
    preservedIntake.value.result,
    preservedIntake.value.records,
  )
  if (!intake.complete)
    return retainFailedOutput(
      preparation.value.prepared,
      intake.records,
      intake.diagnostics,
      product,
      product.identity,
      [`native-intake-incomplete:${intake.diagnostics.join(';')}`],
      intakeCapture.value,
    )
  if (product.runtime.signal.aborted) return failure('fix-run-interrupted-cleanup-unproven')
  const decision = await synthesizeCiCorrection(
    preparation.value.prepared,
    product,
    preparation.value.attribution,
    intake,
  )
  if (!decision.ok) return decision
  if (decision.value.decision.kind !== 'decision') return failure('ci-correction-decision-invalid')
  const retainedDecision = await persistCapturedCauseDispositions(
    preparation.value.prepared.causeContext,
    { kind: 'decision', decision: decision.value.decision },
    product.identity,
    product.dispositionStore,
    product.runtime.uw,
    decision.value.capture,
  )
  if (!retainedDecision.ok) return retainedDecision
  const admittedDecision = await validateSynthesisHistory(product, decision.value.decision)
  if (!admittedDecision.ok) return admittedDecision
  if (product.runtime.signal.aborted) return failure('fix-run-interrupted-cleanup-unproven')
  return executeDecision(
    preparation.value.prepared,
    decision.value.decision,
    product,
    product.identity,
    decision.value.capture,
  )
}
