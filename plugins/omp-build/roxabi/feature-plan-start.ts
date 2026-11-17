import { randomUUID } from 'node:crypto'
import { canonicalValueDigest } from '../dist/contracts.js'
import { currentContextSuccession } from '../engine/workflow-context-succession-current.ts'
import type { PlanMacro } from '../engine/workflow-plan.ts'
import type { WorkflowFacts } from '../engine/workflow-reconstruction-types.ts'
import {
  actionRequest,
  blocks,
  confirmStartReadback,
  deliveryBatch,
  deliveryTask,
  observeCleanHeadCode,
  prepareDeliveryAction,
  prepareRefusal,
  uwSubject,
} from './delivery-action.ts'
import {
  type ApprovedMandateContext,
  approvedMandateContext,
  type MandateRecord,
  planExactInputs,
} from './feature-approved-context.ts'
import type { ContinueFeatureResult } from './feature-contract.ts'
import { type Contracts, type History, publishRecord, type Scope, type WorkflowEvidence } from './feature-engine.ts'
import { type AmendmentPlanMacro, startPlanAmendment } from './feature-plan-amendment.ts'
import { startPlanReview } from './feature-plan-review-start.ts'
import type { PreparedUwAction, UwActionRequest } from './uw-action-contract.ts'
import { expandedPlannerMacro, plannerExpansion } from './uw-action-negative-expansion.ts'
import type { UwOperations } from './uw-contract.ts'
import type { GitRunner } from './workflow-checkout.ts'

type Gh = (cwd: string, args: string[]) => Promise<string>

type ReadyMandateContext = Extract<ApprovedMandateContext, { status: 'ready' }>
type PlannerRecovery = { request: UwActionRequest; prepared: PreparedUwAction }

function isAmendmentPlanMacro(macro: PlanMacro): macro is AmendmentPlanMacro {
  return macro.phase === 'needs-amendment' && macro.draftActionId !== null && macro.reviewActionId !== null
}

async function startPlanDraft(
  contracts: Contracts,
  evidence: WorkflowEvidence,
  history: History,
  gh: Gh,
  cwd: string,
  scope: Scope,
  mandate: MandateRecord,
  approved: ReadyMandateContext,
  uw: UwOperations | undefined,
  git: GitRunner,
  recovery?: PlannerRecovery,
): Promise<ContinueFeatureResult> {
  if (uw === undefined) return blocks('prepare-action-unavailable')
  if (approved.accepted.snapshot.spec.criteria.length === 0) return { kind: 'operator-decision', reason: 'needs-scope' }
  const operationId = recovery?.request.actionId ?? randomUUID()
  const startId = randomUUID()
  const code = await observeCleanHeadCode(git, cwd, scope.repository)
  if (!code.ok) return blocks(code.reason)
  const request = actionRequest({
    actionId: operationId,
    purpose: 'plan',
    subject: uwSubject(scope, null),
    code: code.code,
    expandedContext: recovery?.request.expandedContext,
  })
  const prepared =
    recovery === undefined
      ? await prepareDeliveryAction(uw, request)
      : canonicalValueDigest(request) !== canonicalValueDigest(recovery.request) ||
          !(await uw.verifyAction(recovery.prepared.snapshot)).ok
        ? null
        : { ok: true as const, value: recovery.prepared }
  if (prepared === null) return blocks('context-recovery-input-changed')
  if (!prepared.ok) return blocks(prepareRefusal(prepared.diagnostics), prepared.diagnostics)
  const started = await publishRecord(
    contracts,
    history,
    {
      repository: scope.repository,
      target: scope.target,
      version: 1,
      recordId: startId,
      runId: randomUUID(),
      operationId,
      kind: 'action-receipt',
      payload: {
        phase: 'start',
        action: 'plan',
        actionId: operationId,
        mandate: { scope, recordId: mandate.recordId, kind: 'mandate' },
        exactInputs: planExactInputs({
          mandateId: mandate.recordId,
          specDigest: approved.accepted.ref.version,
          amendsReviewActionId: null,
          requiredBlockers: [],
        }),
        format: 'omp-build-action-receipt/2',
        inputs: prepared.value.inputs,
      },
    },
    gh,
    cwd,
    evidence.parents,
  )
  if (!started.ok) return { kind: 'blocked', reason: started.reason, diagnostics: started.diagnostics }
  const confirmed = await confirmStartReadback({
    read: (scopes) => contracts.readComposedWorkflowHistory(scopes, { cwd, gh }),
    scope,
    recordId: startId,
    inputs: prepared.value.inputs,
  })
  if (!confirmed.ok) return blocks(confirmed.reason)
  return {
    kind: 'action',
    node: 'plan',
    start: { scope, recordId: startId, kind: 'action-receipt' },
    followUp: deliveryBatch(operationId, [
      deliveryTask({
        name: 'R-workflow-plan',
        agent: 'R-workflow-plan',
        procedure:
          'Map every accepted criterion id to the code it changes and the evidence that proves it. Use criterionIds. Do not implement.',
        solutionSpace: 'one plan draft',
        prepared: prepared.value,
      }),
    ]),
  }
}

export async function planAction(
  contracts: Contracts,
  evidence: WorkflowEvidence,
  history: History,
  gh: Gh,
  cwd: string,
  scope: Scope,
  mandate: NonNullable<History['operations'][number]['record']>,
  uw: UwOperations | undefined,
  git: GitRunner,
  recovery?: PlannerRecovery,
  facts?: WorkflowFacts,
): Promise<ContinueFeatureResult> {
  const approved = approvedMandateContext(
    contracts,
    mandate,
    evidence.causal?.histories ?? [history, ...evidence.parents],
  )
  if (approved.status === 'invalid') {
    return { kind: 'blocked', reason: `mandate-spec-${approved.reason}`, diagnostics: approved.diagnostics }
  }
  if (approved.status !== 'ready') return { kind: 'blocked', reason: 'mandate-spec-missing' }
  const succession = currentContextSuccession(evidence, approved.mandate, facts ?? null)
  if (!succession.ok) return blocks('context-succession-unconfirmed', succession.diagnostics)
  const resolved = resolvePlanMacro(contracts, evidence, approved.mandate, recovery, succession.value)
  if ('kind' in resolved) return resolved
  const { macro, expansion } = resolved
  if (macro.phase === 'uncertain' || macro.phase === 'blocked') {
    return { kind: 'blocked', reason: macro.evidence[0]?.code ?? macro.phase, diagnostics: macro.evidence }
  }
  if (macro.phase === 'needs-review') {
    return startPlanReview(
      contracts,
      evidence,
      history,
      gh,
      cwd,
      scope,
      approved.mandate,
      approved,
      macro.draftActionId,
      uw,
      git,
      planReviewRecovery(recovery, expansion),
    )
  }
  if (isAmendmentPlanMacro(macro)) {
    return startPlanAmendment(
      contracts,
      evidence,
      history,
      gh,
      cwd,
      scope,
      approved.mandate,
      approved,
      macro,
      uw,
      git,
      recovery,
    )
  }
  if (macro.phase !== 'needs-draft') return { kind: 'blocked', reason: `plan-phase-${macro.phase}` }
  return startPlanDraft(contracts, evidence, history, gh, cwd, scope, approved.mandate, approved, uw, git, recovery)
}

function planReviewRecovery(
  recovery: PlannerRecovery | undefined,
  expansion: Extract<ReturnType<typeof resolvePlanMacro>, { macro: unknown }>['expansion'],
): (PlannerRecovery & { slotId: string }) | undefined {
  if (recovery === undefined) return undefined
  return {
    ...recovery,
    slotId: expansion?.ok && expansion.value?.slot.action === 'plan-review' ? expansion.value.slot.slotId : '',
  }
}

function resolvePlanMacro(
  contracts: Contracts,
  evidence: WorkflowEvidence,
  mandate: MandateRecord,
  recovery: PlannerRecovery | undefined,
  excludedStarts: ReadonlySet<string>,
) {
  // Plan/implement consume the accepted Spec snapshot, not a live reread.
  const expansion = recovery === undefined ? null : plannerExpansion(recovery.request, evidence.causal.histories)
  if (expansion !== null && (!expansion.ok || expansion.value === null)) return blocks('context-recovery-input-changed')
  const recoveredMacro =
    expansion?.ok && expansion.value !== null
      ? expandedPlannerMacro(evidence, mandate, expansion.value, excludedStarts)
      : null
  if (recoveredMacro !== null && !recoveredMacro.ok) return blocks('context-recovery-input-changed')
  const macro = recoveredMacro?.ok ? recoveredMacro.value : contracts.planMacro(evidence, mandate, { excludedStarts })
  return { macro, expansion }
}
