import type { NativeBatchResult, NativeTask } from '../omp/review-runtime/contracts.ts'
import { createTrustedDebtFiling } from './debt-filing-writer.ts'
import {
  actionRequest,
  codePin,
  confirmPreparedAction,
  deliveryTask,
  recordStageRef,
  uwSubject,
} from './delivery-action.ts'
import { type ExpectedAttributedCiCorrectionInput, reAdmitAttributedCiCorrection } from './fix-ci-admission.ts'
import type { FixActionResult, FixIdentity, FixRecord, PreparedFix, PublishBinding } from './fix-contract.ts'
import { capturedSubmission, failure } from './fix-contract.ts'
import {
  assessFixIntake,
  type FixIntakePublication,
  publishNativeContributions,
  taskSlot,
} from './fix-contributions-native.ts'
import {
  finalizeCorrectionSynthesis,
  type PreservedSynthesis,
  prepareCorrectionSynthesis,
} from './fix-contributions-synthesis.ts'
import type { DebtEvidence, FixPolicy } from './fix-domain'
import { admitDecisionExecution, type DefaultFixWorkflow, defaultDebtEvidence } from './fix-execution-policy.ts'
import { executeDecision } from './fix-execution-runner.ts'
import { confirmFixContinuation } from './fix-mandate-authority.ts'
import type { AttributedCiCorrectionInput, CiCorrectionBound } from './fix-mandate-types.ts'
import { actionTask, dispatchNativeBatch } from './fix-native-dispatch.ts'
import { publish, record } from './fix-records.ts'
import { nativeFixProfileByAction } from './native-review-profiles'

type CiCorrectionProduct = DefaultFixWorkflow & {
  identity: FixIdentity
  publishBinding: PublishBinding
  debtEvidence?: DebtEvidence
}

type AttributedCorrection = Extract<CiCorrectionBound, { status: 'attributed-correction' }>
type CiCorrectionPreparation = { prepared: PreparedFix; intakeTask: NativeTask; evidence: FixRecord }
type PreservedIntake = { result: NativeBatchResult; records: FixRecord[] }
function isFixRequest(record: FixRecord): record is Extract<FixRecord, { kind: 'fix-request' }> {
  return record.kind === 'fix-request'
}

async function prepareCiCorrection(
  input: AttributedCiCorrectionInput,
  product: CiCorrectionProduct,
  admitted: AttributedCorrection,
): Promise<FixActionResult<CiCorrectionPreparation>> {
  const evidence = record(product.identity, input.target, 'contribution', {
    content: 'operator-request',
    inventoryId: null,
    host: { origin: 'native', phase: 'fix', role: 'ci-correction', slotId: null, chunk: null, childId: null },
    rawAttempts: [
      capturedSubmission({
        attributedCiFailure: [...admitted.failedChecks],
        attributionRecordId: admitted.attributionRecordId,
        candidateGitSHA: admitted.candidateGitSHA,
      }),
    ],
    native: null,
    structured: null,
    findings: null,
  })
  const savedEvidence = await publish(product.publisher, evidence)
  if (!savedEvidence.ok) return savedEvidence
  const correctionScope = admitted.uw.ownSpec.snapshot.raw.body
  const request = record(
    product.identity,
    input.target,
    'fix-request',
    {
      requestContributionId: evidence.recordId,
      existingReviewId: null,
      scope: correctionScope,
      landing: false,
    },
    [evidence.recordId],
  )
  const savedRequest = await publish(product.publisher, request)
  if (!savedRequest.ok) return savedRequest
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
  const pinned = codePin(input.target.repository, input.target.baseGitSHA, head, head)
  if (!pinned.ok) return failure('code-unobserved')
  const pullRequest =
    input.target.kind === 'pull-request' ? { repository: input.target.repository, target: input.target.target } : null
  const preparedAction = await confirmPreparedAction(
    product.runtime.uw,
    actionRequest({
      actionId: inventoryId,
      purpose: 'correction',
      subject: uwSubject(admitted.uw.ownSpec.ref.uw, pullRequest),
      code: pinned.code,
      stageSources: evidence.kind === 'contribution' || evidence.kind === 'decision' ? [recordStageRef(evidence)] : [],
    }),
  )
  if (!preparedAction.ok) return failure('prepare-action-unavailable')
  const intakeTask = deliveryTask({
    name: intakeDraft.name,
    agent: intakeDraft.agent,
    procedure: intakeDraft.task,
    solutionSpace: intakeDraft.solutionSpace,
    prepared: preparedAction.value,
    proofEvidence: intakeDraft.proofEvidence,
  })
  const prepared: PreparedFix = {
    target: input.target,
    requestId: request.recordId,
    inventoryId,
    sourceContributionId: evidence.recordId,
    policy,
    cwd: input.cwd,
    publishBinding: product.publishBinding,
    debtFiling: createTrustedDebtFiling(),
    subject: uwSubject(admitted.uw.ownSpec.ref.uw, pullRequest),
    batch: {
      operationId: product.identity.operationId,
      tasks: {
        context: 'omp-build correction action. Read only the procedure and the index named on the task.',
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
    [request.recordId, evidence.recordId],
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
  return { ok: true, value: { prepared, intakeTask, evidence } }
}

async function dispatchCiCorrectionIntake(
  prepared: PreparedFix,
  intakeTask: NativeTask,
  product: CiCorrectionProduct,
  evidence: FixRecord,
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
        [evidence.recordId],
        result,
      ).then((contributions) =>
        contributions.ok ? { ok: true, value: { result, records: contributions.value } } : contributions,
      ),
    true,
  )
}

async function synthesizeCiCorrection(
  prepared: PreparedFix,
  product: CiCorrectionProduct,
  evidence: FixRecord,
  intake: FixIntakePublication,
): Promise<FixActionResult<FixRecord>> {
  const synthesisTask = actionTask(
    'ci-correction-synthesis',
    nativeFixProfileByAction.synthesis,
    'Synthesize one correction-purpose decision only from the confirmed CI attribution and intake records named by the index. Do not replay review findings. Do not edit, commit, push, arm, or land.',
    'one correction decision from attributed CI evidence',
  )
  const synthesis = await prepareCorrectionSynthesis(
    prepared,
    product.identity,
    product.publisher,
    [evidence, ...intake.records],
    synthesisTask,
    product.runtime.uw,
  )
  if (!synthesis.ok) return synthesis
  const preservedSynthesis = await dispatchNativeBatch<PreservedSynthesis>(
    product.native,
    synthesis.value.batch,
    product.runtime,
    async (result) => {
      const contributions = await publishNativeContributions(
        prepared,
        product.identity,
        product.publisher,
        synthesis.value.inventoryId,
        [synthesisTask],
        'synthesis',
        'decision',
        [synthesis.value.inventoryId, ...synthesis.value.sourceContributionIds],
        result,
      )
      return contributions.ok ? { ok: true, value: { result, contributions: contributions.value } } : contributions
    },
    false,
  )
  if (!preservedSynthesis.ok) return preservedSynthesis
  if (product.runtime.signal.aborted) return failure('fix-run-interrupted-cleanup-unproven')
  return finalizeCorrectionSynthesis(
    prepared,
    synthesis.value,
    product.identity,
    product.publisher,
    preservedSynthesis.value,
    product.runtime.signal,
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
  const preservedIntake = await dispatchCiCorrectionIntake(
    preparation.value.prepared,
    preparation.value.intakeTask,
    product,
    preparation.value.evidence,
  )
  if (!preservedIntake.ok) return preservedIntake
  const intake = assessFixIntake(
    preparation.value.prepared,
    preservedIntake.value.result,
    preservedIntake.value.records,
  )
  if (!intake.complete) return failure(`native-intake-incomplete:${intake.diagnostics.join(';')}`)
  if (product.runtime.signal.aborted) return failure('fix-run-interrupted-cleanup-unproven')
  const decision = await synthesizeCiCorrection(preparation.value.prepared, product, preparation.value.evidence, intake)
  if (!decision.ok) return decision
  if (decision.value.kind !== 'decision') return failure('ci-correction-decision-invalid')
  try {
    const history = await product.readHistory()
    if (!history.source.complete) return failure('correction-synthesis-history-incomplete')
    const admission = admitDecisionExecution(decision.value, history)
    if (!admission.ok) return admission
  } catch (error) {
    return failure(`correction-synthesis-history-unreadable:${error instanceof Error ? error.message : String(error)}`)
  }
  if (product.runtime.signal.aborted) return failure('fix-run-interrupted-cleanup-unproven')
  return executeDecision(
    preparation.value.prepared,
    decision.value,
    product,
    product.identity,
    product.debtEvidence ?? defaultDebtEvidence,
  )
}
