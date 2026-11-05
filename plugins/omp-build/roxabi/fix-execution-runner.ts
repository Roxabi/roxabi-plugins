import { sameOwnSpecRef } from '../dist/contracts.js'
import type { NativeBatchResult } from '../omp/review-runtime/contracts.ts'
import type { NativeCorrectionExecutionOptions } from './correction-execution-contract.ts'
import { createNativeCorrectionExecution } from './correction-native-execution.ts'
import { executeCorrectionPlan } from './correction-plan.ts'
import { bindCorrectionAction } from './fix-action-binding.ts'
import { publishFinalFixResult, publishFixArtifacts } from './fix-artifact.ts'
import type { FixActionResult, FixIdentity, FixRecord, PreparedFix } from './fix-contract.ts'
import { failure } from './fix-contract.ts'
import { assessFixIntake, publishNativeContributions } from './fix-contributions-native.ts'
import {
  finalizeCorrectionSynthesis,
  type PreservedSynthesis,
  prepareCorrectionSynthesis,
} from './fix-contributions-synthesis.ts'
import { correctionObservationRefs } from './fix-correction-observation-refs.ts'
import { correctionCriterionReceipt } from './fix-criterion-receipt.ts'
import { persistCauseDispositions } from './fix-disposition-execution.ts'
import { admitStoredDecision, authorizeCorrectionContinuation, correctionStarted } from './fix-execution-authority.ts'
import {
  type DefaultFixRequest,
  type DefaultFixWorkflow,
  defaultIntakeTask,
  defaultSynthesisTask,
} from './fix-execution-policy.ts'
import { pushAndReadHead, retainFailedOutput } from './fix-execution-support.ts'
import { dispatchNativeBatch } from './fix-native-dispatch.ts'
import { resolveFixOrigin } from './fix-origin.ts'
import { prepareStandaloneFix } from './fix-preparation.ts'

export async function executeDecision(
  prepared: PreparedFix,
  decision: Extract<FixRecord, { kind: 'decision' }>,
  product: Pick<DefaultFixWorkflow, 'native' | 'publisher' | 'runtime' | 'readHistory' | 'dispositionStore' | 'github'>,
  identity: FixIdentity,
): Promise<FixActionResult<FixRecord>> {
  if (product.runtime.signal.aborted) return failure('fix-run-interrupted-cleanup-unproven')
  const disposition = await persistCauseDispositions(
    prepared,
    { kind: 'decision', decision },
    identity,
    product.dispositionStore,
  )
  if (!disposition.ok) return disposition
  if (disposition.value.pending) return failure('correction-disposition-pending-blocking')
  const admissions = decision.payload.judgment.causes
    .filter((cause) => disposition.value.executable.has(cause.id))
    .map((cause) => ({ status: 'selected' as const, cause, required: true }))
  const criterionSources: Parameters<NonNullable<NativeCorrectionExecutionOptions['onCriterionSource']>>[0][] = []
  const executor = createNativeCorrectionExecution({
    native: product.native,
    prepared,
    operationId: identity.operationId,
    decisionId: decision.recordId,
    decision: {
      repository: decision.repository,
      target: decision.target,
      kind: 'decision',
      recordId: decision.recordId,
      payload: decision.payload,
    },
    correctionObservationRefs: () => correctionObservationRefs(prepared, decision, product),
    operations: product.runtime.uw,
    authorizeContinuation: async () => {
      const authorized = await authorizeCorrectionContinuation(product.runtime)
      if (!authorized.ok) return authorized
      const origin = await resolveFixOrigin(prepared.causeContext.original, product.runtime.uw)
      if (!origin.ok) return origin
      if (!sameOwnSpecRef(origin.value.effective.own, prepared.causeContext.effective.own))
        return failure('correction-origin-stale')
      const current = await persistCauseDispositions(
        prepared,
        { kind: 'decision', decision },
        identity,
        product.dispositionStore,
      )
      if (!current.ok) return current
      if (current.value.pending || JSON.stringify(current.value.refs) !== JSON.stringify(disposition.value.refs))
        return failure('correction-disposition-changed')
      const admitted = await admitStoredDecision(
        decision,
        product,
        'correction-decision-history-incomplete',
        'correction-decision-history-unreadable',
      )
      return admitted.ok ? { ok: true, value: undefined } : admitted
    },
    signal: product.runtime.signal,
    bindAction: (binding) =>
      bindCorrectionAction(
        prepared,
        identity,
        product.publisher,
        decision.recordId,
        product.runtime,
        binding,
        product.readHistory,
      ),
    onCriterionSource: (source) => criterionSources.push(source),
    onStarted: (batch) => correctionStarted(product.runtime, batch),
  })
  const plan = await executeCorrectionPlan(admissions, executor)
  if (!plan.ok && plan.terminalDiagnostics !== null) return failure(...plan.terminalDiagnostics)
  if (product.runtime.signal.aborted) return failure('fix-run-interrupted-cleanup-unproven')
  const artifacts = await publishFixArtifacts(
    prepared,
    identity,
    product.publisher,
    decision.recordId,
    plan.outcomes,
    disposition.value,
    product.runtime.signal,
    criterionSources,
  )
  if (!artifacts.ok) return artifacts
  if (!plan.ok) return failure(...(plan.terminalDiagnostics ?? ['correction-terminal-cleanup-unproven']))
  if (product.runtime.signal.aborted) return failure('fix-run-interrupted-cleanup-unproven')
  const head = await pushAndReadHead(
    executor,
    plan.outcomes.some((outcome) => outcome.outcome === 'applied'),
    product.runtime.signal,
  )
  if (!head.ok) return head
  return publishFinalFixResult(
    prepared,
    identity,
    product.publisher,
    decision.recordId,
    artifacts.value,
    head.value,
    correctionCriterionReceipt(criterionSources, plan.outcomes, head.value),
  )
}

/** Product default: dispatch sequential native intake and synthesis outside SDK callbacks, then apply policy. */
export async function runDefaultFixWorkflow(
  product: DefaultFixWorkflow,
  input: DefaultFixRequest,
): Promise<FixActionResult<FixRecord>> {
  const prepared = await prepareStandaloneFix(
    { ...input, nativeTasks: [defaultIntakeTask(input)] },
    product.resolver,
    product.publisher,
    product.workflow,
    product.runtime.signal,
  )
  if (!prepared.ok) return prepared
  const preservedIntake = await dispatchNativeBatch<{ result: NativeBatchResult; records: FixRecord[] }>(
    product.native,
    prepared.value.batch,
    product.runtime,
    (result: NativeBatchResult) =>
      publishNativeContributions(
        prepared.value,
        input.identity,
        product.publisher,
        prepared.value.inventoryId,
        prepared.value.batch.tasks.tasks,
        'intake',
        'findings',
        [prepared.value.inventoryId],
        result,
      ).then((contributions) =>
        contributions.ok ? { ok: true, value: { result, records: contributions.value } } : contributions,
      ),
    true,
  )
  if (!preservedIntake.ok) return preservedIntake
  const intake = assessFixIntake(prepared.value, preservedIntake.value.result, preservedIntake.value.records)
  if (!intake.complete)
    return retainFailedOutput(prepared.value, intake.records, intake.diagnostics, product, input.identity, [
      `native-intake-incomplete:${intake.diagnostics.join(';')}`,
    ])
  if (product.runtime.signal.aborted) return failure('fix-run-interrupted-cleanup-unproven')
  const synthesis = await prepareCorrectionSynthesis(
    prepared.value,
    input.identity,
    product.publisher,
    intake.records,
    defaultSynthesisTask(),
    product.runtime.uw,
  )
  if (!synthesis.ok) return synthesis
  const preservedSynthesis = await dispatchNativeBatch<PreservedSynthesis>(
    product.native,
    synthesis.value.batch,
    product.runtime,
    async (result: NativeBatchResult) => {
      const contributions = await publishNativeContributions(
        prepared.value,
        input.identity,
        product.publisher,
        synthesis.value.inventoryId,
        synthesis.value.batch.tasks.tasks,
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
  const decision = await finalizeCorrectionSynthesis(
    prepared.value,
    synthesis.value,
    input.identity,
    product.publisher,
    preservedSynthesis.value,
    product.runtime.signal,
  )
  if (!decision.ok)
    return retainFailedOutput(
      prepared.value,
      [...intake.records, ...preservedSynthesis.value.contributions],
      decision.diagnostics,
      product,
      input.identity,
      decision.diagnostics,
    )
  if (product.runtime.signal.aborted) return failure('fix-run-interrupted-cleanup-unproven')
  if (decision.value.kind !== 'decision') return failure('correction-synthesis-decision-invalid')
  const retainedDecision = await persistCauseDispositions(
    prepared.value,
    { kind: 'decision', decision: decision.value },
    input.identity,
    product.dispositionStore,
  )
  if (!retainedDecision.ok) return retainedDecision
  const admission = await admitStoredDecision(
    decision.value as Extract<FixRecord, { kind: 'decision' }>,
    product,
    'correction-synthesis-history-incomplete',
    'correction-synthesis-history-unreadable',
  )
  if (!admission.ok) return admission
  if (product.runtime.signal.aborted) return failure('fix-run-interrupted-cleanup-unproven')
  return executeDecision(
    prepared.value,
    decision.value as Extract<FixRecord, { kind: 'decision' }>,
    product,
    input.identity,
  )
}

export async function runReviewBoundFixWorkflow(
  prepared: PreparedFix,
  decision: Extract<FixRecord, { kind: 'decision' }>,
  product: Pick<DefaultFixWorkflow, 'native' | 'publisher' | 'runtime' | 'readHistory' | 'dispositionStore' | 'github'>,
  identity: FixIdentity,
): Promise<FixActionResult<FixRecord>> {
  const retainedDecision = await persistCauseDispositions(
    prepared,
    { kind: 'decision', decision },
    identity,
    product.dispositionStore,
  )
  if (!retainedDecision.ok) return retainedDecision
  const admission = await admitStoredDecision(
    decision,
    product,
    'review-fix-history-incomplete',
    'review-fix-history-unreadable',
  )
  if (!admission.ok) return admission
  return executeDecision(prepared, decision, product, identity)
}
