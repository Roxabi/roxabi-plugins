import { randomUUID } from 'node:crypto'
import type { PlanMacro } from '../engine/workflow-plan.ts'
import type { PlanReviewSlot } from '../engine/workflow-receipt-schema.ts'
import { batch } from './feature-action-prompts.ts'
import {
  type ApprovedMandateContext,
  actionReceiptResult,
  approvedMandateContext,
  type MandateRecord,
  planExactInputs,
  planReviewExactInputs,
  planReviewOriginalsBlock,
  planStructuredBlock,
} from './feature-approved-context.ts'
import type { ContinueFeatureResult } from './feature-contract.ts'
import { type Contracts, type History, publishRecord, type Scope, type WorkflowEvidence } from './feature-engine.ts'

function criteriaText(approved: ReadyMandateContext): string[] {
  return approved.accepted.snapshot.spec.criteria.map((criterion) => `${criterion.id}: ${criterion.statement}`)
}
type Gh = (cwd: string, args: string[]) => Promise<string>

type ReadyMandateContext = Extract<ApprovedMandateContext, { status: 'ready' }>
type AmendmentPlanMacro = PlanMacro & {
  phase: 'needs-amendment'
  draftActionId: string
  reviewActionId: string
}

function isAmendmentPlanMacro(macro: PlanMacro): macro is AmendmentPlanMacro {
  return macro.phase === 'needs-amendment' && macro.draftActionId !== null && macro.reviewActionId !== null
}

async function startPlanReview(
  contracts: Contracts,
  evidence: WorkflowEvidence,
  history: History,
  gh: Gh,
  cwd: string,
  scope: Scope,
  mandate: MandateRecord,
  approved: ReadyMandateContext,
  draftActionId: string | null,
): Promise<ContinueFeatureResult> {
  if (draftActionId === null) return { kind: 'blocked', reason: 'plan-review-unbound' }
  const draft = actionReceiptResult(history, 'plan', draftActionId)
  const structured = draft?.payload.structured ?? null
  if (structured === null) return { kind: 'blocked', reason: 'plan-draft-unreadable' }
  const planDigest = contracts.planDigest(structured)
  const operationId = randomUUID()
  const startId = randomUUID()
  const slots: PlanReviewSlot[] = [
    { slotId: 'architect', specialist: 'R-workflow-plan-architect' },
    { slotId: 'adversarial', specialist: 'R-workflow-plan-adversarial' },
  ]
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
        action: 'plan-review',
        actionId: operationId,
        mandate: { scope, recordId: mandate.recordId, kind: 'mandate' },
        exactInputs: planReviewExactInputs({
          mandateId: mandate.recordId,
          draftActionId,
          specDigest: approved.accepted.ref.version,
          planDigest,
        }),
        slots,
      },
    },
    gh,
    cwd,
    evidence.parents,
  )
  if (!started.ok) return { kind: 'blocked', reason: started.reason, diagnostics: started.diagnostics }
  const criteria = criteriaText(approved)
  const draftBlock = `Confirmed plan draft actionId=${draftActionId}:\n${JSON.stringify(structured)}`
  const reviewTask = [
    `Review the confirmed plan draft ${draftActionId}.`,
    `Acceptance criteria: ${criteria.join(' | ')}`,
    approved.specBlock,
    draftBlock,
    'Return clear or blocking blockers only. Do not implement.',
  ].join('\n')
  return {
    kind: 'action',
    node: 'plan-review',
    start: { scope, recordId: startId, kind: 'action-receipt' },
    followUp: batch(operationId, [
      { name: 'architect', agent: 'R-workflow-plan-architect', task: reviewTask },
      {
        name: 'adversarial',
        agent: 'R-workflow-plan-adversarial',
        task: [
          `Adversarially review the confirmed plan draft ${draftActionId}.`,
          `Acceptance criteria: ${criteria.join(' | ')}`,
          approved.specBlock,
          draftBlock,
          'Return clear or blocking blockers only. Do not implement.',
        ].join('\n'),
      },
    ]),
  }
}

async function startPlanAmendment(
  contracts: Contracts,
  evidence: WorkflowEvidence,
  history: History,
  gh: Gh,
  cwd: string,
  scope: Scope,
  mandate: MandateRecord,
  approved: ReadyMandateContext,
  macro: AmendmentPlanMacro,
): Promise<ContinueFeatureResult> {
  const criteria = criteriaText(approved)
  const draftBlock = planStructuredBlock(history, macro.draftActionId, 'Original plan draft')
  if (draftBlock === null) return { kind: 'blocked', reason: 'plan-draft-unreadable' }
  const originals = planReviewOriginalsBlock(history, macro.reviewActionId)
  if (originals === null) return { kind: 'blocked', reason: 'plan-review-unbound' }
  const operationId = randomUUID()
  const startId = randomUUID()
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
          amendsReviewActionId: macro.reviewActionId,
          requiredBlockers: macro.blockers,
        }),
      },
    },
    gh,
    cwd,
    evidence.parents,
  )
  if (!started.ok) return { kind: 'blocked', reason: started.reason, diagnostics: started.diagnostics }
  return {
    kind: 'action',
    node: 'plan',
    start: { scope, recordId: startId, kind: 'action-receipt' },
    followUp: batch(operationId, [
      {
        name: 'R-workflow-plan',
        agent: 'R-workflow-plan',
        task: [
          'Amend the plan to address every required blocker without changing the original review labels.',
          `Stable required blockers=${JSON.stringify(macro.blockers)}`,
          `Acceptance criteria: ${criteria.join(' | ')}`,
          approved.specBlock,
          draftBlock,
          originals,
          'Do not implement.',
        ].join('\n'),
      },
    ]),
  }
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
): Promise<ContinueFeatureResult> {
  const criteria = criteriaText(approved)
  if (criteria.length === 0) return { kind: 'operator-decision', reason: 'needs-scope' }
  const operationId = randomUUID()
  const startId = randomUUID()
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
      },
    },
    gh,
    cwd,
    evidence.parents,
  )
  if (!started.ok) return { kind: 'blocked', reason: started.reason, diagnostics: started.diagnostics }
  const reread = await contracts.readComposedWorkflowHistory([scope], { cwd, gh })
  const seen =
    reread.ok &&
    reread.histories[0]?.operations.some(
      (operation) => operation.record?.kind === 'action-receipt' && operation.record.payload.actionId === operationId,
    ) === true
  if (!seen) return { kind: 'blocked', reason: 'action-uncertain' }
  return {
    kind: 'action',
    node: 'plan',
    start: { scope, recordId: startId, kind: 'action-receipt' },
    followUp: batch(operationId, [
      {
        name: 'R-workflow-plan',
        agent: 'R-workflow-plan',
        task: [
          'Map every acceptance criterion to the code it changes and the evidence that proves it. Do not implement.',
          `Acceptance criteria: ${criteria.join(' | ')}`,
          approved.specBlock,
        ].join('\n'),
      },
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
): Promise<ContinueFeatureResult> {
  const approved = approvedMandateContext(contracts, mandate, [history, ...evidence.parents])
  if (approved.status === 'invalid') {
    return { kind: 'blocked', reason: `mandate-spec-${approved.reason}`, diagnostics: approved.diagnostics }
  }
  if (approved.status !== 'ready') return { kind: 'blocked', reason: 'mandate-spec-missing' }
  // Plan/implement consume the accepted Spec snapshot, not a live reread.
  const macro = contracts.planMacro(evidence, approved.mandate)
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
    )
  }
  if (isAmendmentPlanMacro(macro)) {
    return startPlanAmendment(contracts, evidence, history, gh, cwd, scope, approved.mandate, approved, macro)
  }
  if (macro.phase !== 'needs-draft') return { kind: 'blocked', reason: `plan-phase-${macro.phase}` }
  return startPlanDraft(contracts, evidence, history, gh, cwd, scope, approved.mandate, approved)
}
