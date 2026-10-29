import type { NativeBatch, NativeBatchResult } from '../omp/review-runtime/contracts.ts'
import { groupCorrectionDebt } from './correction-debt.ts'
import type { CorrectionEffectResult, NativeCorrectionExecutionOptions } from './correction-execution-contract.ts'
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
import type { DebtEvidence, FixFinding } from './fix-domain'
import {
  admitDecisionExecution,
  type DefaultFixRequest,
  type DefaultFixWorkflow,
  defaultDebtEvidence,
  defaultIntakeTask,
  defaultSynthesisTask,
  selectedCorrectionOrder,
} from './fix-execution-policy.ts'
import { dispatchNativeBatch } from './fix-native-dispatch.ts'
import { prepareStandaloneFix } from './fix-preparation.ts'

async function authorizeCorrectionContinuation(runtime: DefaultFixWorkflow['runtime']) {
  const allowed =
    runtime.beforeContinuation === undefined
      ? { ok: true as const, value: undefined }
      : await runtime.beforeContinuation()
  return allowed.ok ? { ok: true as const, value: undefined } : allowed
}

async function correctionStarted(
  runtime: DefaultFixWorkflow['runtime'],
  batch: NativeBatch,
): Promise<CorrectionEffectResult<void>> {
  if (runtime.signal.aborted) return { ok: false, kind: 'terminal', diagnostics: ['fix-run-aborted'] }
  runtime.onStarted(batch)
  return { ok: true, value: undefined }
}

async function admitStoredDecision(
  decision: Extract<FixRecord, { kind: 'decision' }>,
  product: Pick<DefaultFixWorkflow, 'readHistory'>,
  incompleteDiagnostic: string,
  unreadableDiagnostic: string,
): Promise<FixActionResult<void>> {
  try {
    const history = await product.readHistory()
    if (!history.source.complete) return failure(incompleteDiagnostic)
    return admitDecisionExecution(decision, history)
  } catch (error) {
    return failure(`${unreadableDiagnostic}:${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function executeDecision(
  prepared: PreparedFix,
  decision: Extract<FixRecord, { kind: 'decision' }>,
  product: Pick<DefaultFixWorkflow, 'native' | 'publisher' | 'runtime' | 'readHistory'>,
  identity: FixIdentity,
  debtEvidence: DebtEvidence,
): Promise<FixActionResult<FixRecord>> {
  if (product.runtime.signal.aborted) return failure('fix-run-interrupted-cleanup-unproven')
  const judgment = decision.payload.judgment
  const findings: FixFinding[] = judgment.findings.map((finding) => ({
    id: finding.id,
    label: finding.label,
    usable: finding.state === 'usable',
  }))
  const admissions = selectedCorrectionOrder(prepared.policy, judgment.causes, findings)
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
  const debt = groupCorrectionDebt({
    policy: prepared.policy,
    findings,
    causes: judgment.causes,
    admissions,
    outcomes: plan.outcomes,
    retainedObligations: plan.retainedObligations,
    evidenceFor: () => debtEvidence,
  })
  if (product.runtime.signal.aborted) return failure('fix-run-interrupted-cleanup-unproven')
  const artifacts = await publishFixArtifacts(
    prepared,
    identity,
    product.publisher,
    decision.recordId,
    plan.outcomes,
    debt,
    product.runtime.signal,
    criterionSources,
  )
  if (!artifacts.ok) return artifacts
  if (!plan.ok) return failure(...(plan.terminalDiagnostics ?? ['correction-terminal-cleanup-unproven']))
  if (product.runtime.signal.aborted) return failure('fix-run-interrupted-cleanup-unproven')
  const applied = plan.outcomes.some((outcome) => outcome.outcome === 'applied')
  if (applied) {
    const pushed = await executor.push()
    if (!pushed.ok) return failure(...pushed.diagnostics)
    if (product.runtime.signal.aborted) return failure('fix-run-interrupted-cleanup-unproven')
  }
  const head = await executor.head()
  if (!head.ok) return failure(...head.diagnostics)
  if (product.runtime.signal.aborted) return failure('fix-run-interrupted-cleanup-unproven')
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
  if (!intake.complete) return failure(`native-intake-incomplete:${intake.diagnostics.join(';')}`)
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
  if (!decision.ok) return decision
  if (product.runtime.signal.aborted) return failure('fix-run-interrupted-cleanup-unproven')
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
    input.debtEvidence ?? defaultDebtEvidence,
  )
}

export async function runReviewBoundFixWorkflow(
  prepared: PreparedFix,
  decision: Extract<FixRecord, { kind: 'decision' }>,
  product: Pick<DefaultFixWorkflow, 'native' | 'publisher' | 'runtime' | 'readHistory'>,
  identity: FixIdentity,
  debtEvidence: DebtEvidence = {
    important: 'unknown',
    urgent: 'unknown',
    tooLarge: 'unknown',
    evidence: { source: 'review-bound-fix', status: 'unqualified' },
  },
): Promise<FixActionResult<FixRecord>> {
  const admission = await admitStoredDecision(
    decision,
    product,
    'review-fix-history-incomplete',
    'review-fix-history-unreadable',
  )
  if (!admission.ok) return admission
  return executeDecision(prepared, decision, product, identity, debtEvidence)
}
