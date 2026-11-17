import { assessCriterionDeclarations } from './criterion-admission.ts'
import { integrationReceiptEligible, integrationStartPaired, uniqueAccounted } from './delivery-eligibility.ts'
import { diagnostic, sameRef } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import { resolveSpecEffective } from './spec-effective.ts'
import type { SpecEffective } from './spec-effective-schema.ts'
import { toDiagnostics } from './uw-diagnostics.ts'
import { integrationOutputSchema } from './uw-integration-schema.ts'
import { resolveAcceptedSpec } from './workflow-accepted-spec.ts'
import { classifyAttempts, interruptionGate } from './workflow-action-interruption.ts'
import { workflowContextNegative } from './workflow-context-output.ts'
import { selectedContextRecovery } from './workflow-context-recovery.ts'
import { currentContextSuccession } from './workflow-context-succession-current.ts'
import { workflowContextTerminal } from './workflow-context-terminal.ts'
import { excludedReceipt, type MandateRecord, mandateScope, type ReceiptRecord, recordsOf } from './workflow-control.ts'
import { implementationOutputSchema } from './workflow-output-schema.ts'
import type { ActionCompletion, WorkflowEvidence } from './workflow-plan.ts'
import { planMacro } from './workflow-plan-macro.ts'
import { plannerRecoveryCompletion } from './workflow-planner-recovery.ts'
import type { WorkflowFacts } from './workflow-reconstruction-types.ts'

type ImplementationReceipt = ReceiptRecord & {
  payload: Extract<ReceiptRecord['payload'], { action: 'implement' | 'integrate' }>
}
type ImplementationResult = ImplementationReceipt & {
  payload: Extract<ImplementationReceipt['payload'], { phase: 'result' }>
}

function implementationReceipts(
  history: WorkflowEvidence['issue'],
  action: 'implement' | 'integrate',
): ImplementationReceipt[] {
  return recordsOf(history).filter(
    (record): record is ImplementationReceipt => record.kind === 'action-receipt' && record.payload.action === action,
  )
}

function unpairedStart(receipts: readonly ImplementationReceipt[]): boolean {
  const starts = receipts.filter((record) => record.payload.phase === 'start')
  const results = receipts.filter((record) => record.payload.phase === 'result')
  return starts.some((start) => !results.some((result) => result.payload.actionId === start.payload.actionId))
}

function isUnadmittedImplementation(record: ImplementationReceipt): boolean {
  if (record.payload.phase !== 'result' || record.payload.admission?.admitted !== true) return true
  if (record.payload.action === 'integrate')
    return !integrationOutputSchema.safeParse(record.payload.structured).success
  const parsed = implementationOutputSchema.safeParse(record.payload.structured)
  return !parsed.success || parsed.data.outcome !== 'implemented'
}

function sameMandate(record: ImplementationReceipt, mandateRef: ExternalRecordRef, mandateId: string): boolean {
  return sameRef(record.payload.mandate, mandateRef) && record.payload.exactInputs.mandateId === mandateId
}

function implementationForPlan(
  receipts: readonly ImplementationReceipt[],
  mandate: MandateRecord,
  planActionId: string,
): ImplementationReceipt[] {
  const mandateRef: ExternalRecordRef = { scope: mandateScope(mandate), recordId: mandate.recordId, kind: 'mandate' }
  return receipts.filter(
    (record) =>
      sameMandate(record, mandateRef, mandate.recordId) && record.payload.exactInputs.planActionId === planActionId,
  )
}

function macroBlocked(
  evidence: WorkflowEvidence,
  mandate: MandateRecord | null,
  excludedStarts: ReadonlySet<string>,
): ActionCompletion | null {
  const macro = planMacro(evidence, mandate, { excludedStarts })
  if (macro.phase === 'blocked') return { status: 'blocked', evidence: macro.evidence }
  if (macro.phase === 'uncertain') return { status: 'uncertain', evidence: macro.evidence }
  if (macro.phase !== 'eligible') return { status: 'not-started', evidence: [] }
  return null
}

function hasRejectedResult(receipts: readonly ImplementationReceipt[]): boolean {
  return receipts.some((record) => record.payload.phase === 'result' && isUnadmittedImplementation(record))
}

function coveredImplementation(
  latestRecord: ImplementationResult,
  mandate: MandateRecord,
  spec: SpecEffective,
): ActionCompletion {
  const latest =
    latestRecord.payload.action === 'integrate'
      ? integrationOutputSchema.safeParse(latestRecord.payload.structured)
      : implementationOutputSchema.safeParse(latestRecord.payload.structured)
  if (!latest.success || (latest.data.outcome !== 'implemented' && latest.data.outcome !== 'integrated')) {
    return { status: 'blocked', evidence: [diagnostic('unconfirmed', 'implement result was not admitted')] }
  }
  const commit = latestRecord.payload.admission?.remoteTip
  if (commit == null) {
    return { status: 'blocked', evidence: [diagnostic('unconfirmed', 'implement result has no admitted remote tip')] }
  }
  const covered = assessCriterionDeclarations({
    spec,
    code: { repository: mandate.repository, commit },
    declarations: latest.data.criteria,
  })
  if (!covered.ok) return { status: 'blocked', evidence: covered.diagnostics }
  return { status: 'confirmed', evidence: [] }
}

function admittedResult(
  mandate: MandateRecord,
  receipts: readonly ImplementationReceipt[],
  planActionId: string,
  spec: SpecEffective,
  history: WorkflowEvidence['issue'],
): ActionCompletion {
  const selectedReceipts = implementationForPlan(receipts, mandate, planActionId)
  const starts = selectedReceipts.filter((record) => record.payload.phase === 'start')
  const results = selectedReceipts.filter((record): record is ImplementationResult => record.payload.phase === 'result')
  if (starts.length === 0 && results.length === 0) return { status: 'not-started', evidence: [] }
  const implemented = results.filter(
    (record) => !isUnadmittedImplementation(record) && record.payload.admission?.remoteTip != null,
  )
  const paired = implemented.filter(
    (result) =>
      result.payload.action !== 'integrate' ||
      (integrationReceiptEligible(result) && integrationStartPaired(history, result)),
  )
  const selected = uniqueAccounted(paired, 'current implementation')
  if (!selected.ok) return { status: 'blocked', evidence: selected.diagnostics }
  if (selected.value === null) {
    return { status: 'blocked', evidence: [diagnostic('unconfirmed', 'implement result was not admitted')] }
  }
  return coveredImplementation(selected.value, mandate, spec)
}

function mandatedCompletion(
  evidence: WorkflowEvidence,
  mandate: MandateRecord,
  receipts: readonly ImplementationReceipt[],
  excludedStarts: ReadonlySet<string>,
): ActionCompletion {
  const accepted = resolveAcceptedSpec(mandate, evidence.causal.histories)
  if (!accepted.ok) return { status: 'blocked', evidence: accepted.evidence }
  const effective = resolveSpecEffective({
    mode: 'current',
    own: accepted.spec.ref,
    histories: evidence.causal.histories,
    graph: evidence.causal.observation.graph,
  })
  if (!effective.ok) return { status: 'blocked', evidence: toDiagnostics(effective.diagnostics) }
  const blocked = macroBlocked(evidence, mandate, excludedStarts)
  if (blocked !== null) {
    if (blocked.status === 'not-started' && hasRejectedResult(receipts)) {
      return { status: 'blocked', evidence: [diagnostic('unconfirmed', 'implement result was not admitted')] }
    }
    return blocked
  }
  const macro = planMacro(evidence, mandate, { excludedStarts })
  const planActionId = macro.amendmentActionId ?? macro.draftActionId
  if (planActionId === null) return { status: 'not-started', evidence: [] }
  return admittedResult(mandate, receipts, planActionId, effective.value, evidence.issue)
}

function selectedRecovery(
  evidence: WorkflowEvidence,
  mandate: MandateRecord,
  receipts: readonly ImplementationReceipt[],
  excluded: ReadonlySet<string>,
  recovery: NonNullable<WorkflowFacts['contextRecovery']>,
  excludedStarts: ReadonlySet<string>,
): boolean {
  const action = receipts[0]?.payload.action
  if (action === undefined) return false
  const negative = selectedContextRecovery(evidence, mandate, action, excluded, recovery)
  if (negative === null || (negative.payload.action !== 'implement' && negative.payload.action !== 'integrate'))
    return false
  if (receipts.some((record) => record.payload.phase === 'result' && !workflowContextNegative(record))) return false
  const macro = planMacro(evidence, mandate, { excludedStarts })
  return (
    macro.phase === 'eligible' &&
    negative.payload.exactInputs.mandateId === mandate.recordId &&
    negative.payload.exactInputs.planActionId === (macro.amendmentActionId ?? macro.draftActionId)
  )
}

export function implementationCompletion(
  evidence: WorkflowEvidence,
  mandate: MandateRecord | null,
  facts: WorkflowFacts | null = null,
): ActionCompletion {
  const accepted = mandate === null ? null : resolveAcceptedSpec(mandate, evidence.causal.histories)
  if (accepted !== null && !accepted.ok) return { status: 'blocked', evidence: accepted.evidence }
  const action = accepted?.ok && accepted.spec.children.length > 0 ? 'integrate' : 'implement'
  const histories = [evidence.issue, ...evidence.causal.histories]
  const classified = classifyAttempts({ histories, scan: [evidence.issue], actions: ['implement', 'integrate'] })
  if (!classified.ok) return { status: 'blocked', evidence: classified.diagnostics }
  const disposition =
    mandate === null
      ? { ok: true as const, value: new Set<string>() }
      : currentContextSuccession(evidence, mandate, facts)
  if (!disposition.ok) return { status: 'blocked', evidence: disposition.diagnostics }
  const excluded = new Set([...classified.value.excluded, ...disposition.value])
  const receipts = implementationReceipts(evidence.issue, action).filter((record) => !excludedReceipt(record, excluded))
  const gate = interruptionGate(classified)
  if (gate.kind === 'stop') return gate.completion
  const context = deliveryContextCompletion(evidence, mandate, facts, action, receipts, excluded, disposition.value)
  if (context !== null) return context
  if (unpairedStart(receipts)) {
    return { status: 'uncertain', evidence: [diagnostic('action-uncertain', 'implement start has no result')] }
  }
  const plannerRecovery = deliveryPlannerRecovery(evidence, mandate, facts, disposition.value, receipts)
  if (plannerRecovery !== null) return plannerRecovery
  if (mandate === null)
    return macroBlocked(evidence, mandate, disposition.value) ?? { status: 'not-started', evidence: [] }
  return mandatedCompletion(evidence, mandate, receipts, disposition.value)
}

function deliveryPlannerRecovery(
  evidence: WorkflowEvidence,
  mandate: MandateRecord | null,
  facts: WorkflowFacts | null,
  disposition: ReadonlySet<string>,
  receipts: readonly ImplementationReceipt[],
): ActionCompletion | null {
  const recovery = plannerRecoveryCompletion(evidence, mandate, facts, disposition)
  if (recovery === null || recovery.status !== 'not-started') return null
  if (receipts.some((record) => record.payload.phase === 'result'))
    return {
      status: 'blocked',
      evidence: [diagnostic('unconfirmed', 'Existing delivery result prevents planner recovery')],
    }
  return recovery
}

function deliveryContextCompletion(
  evidence: WorkflowEvidence,
  mandate: MandateRecord | null,
  facts: WorkflowFacts | null,
  action: 'implement' | 'integrate',
  receipts: readonly ImplementationReceipt[],
  excluded: ReadonlySet<string>,
  disposition: ReadonlySet<string>,
): ActionCompletion | null {
  const otherAction = action === 'implement' ? 'integrate' : 'implement'
  const otherTerminal = workflowContextTerminal(evidence.issue, otherAction, undefined, excluded)
  if (otherTerminal !== 'clear')
    return {
      status: otherTerminal === 'uncertain' ? 'uncertain' : 'blocked',
      evidence: [
        diagnostic(
          otherTerminal === 'missing' ? 'action-context-missing' : 'unconfirmed',
          'Other delivery context remains unresolved',
        ),
      ],
    }
  const terminal = workflowContextTerminal(evidence.issue, action, undefined, excluded)
  if (
    terminal === 'missing' &&
    mandate !== null &&
    facts?.contextRecovery !== undefined &&
    selectedRecovery(evidence, mandate, receipts, excluded, facts.contextRecovery, disposition)
  )
    return { status: 'not-started', evidence: [] }
  if (terminal === 'missing')
    return {
      status: 'blocked',
      evidence: [diagnostic('action-context-missing', 'implement requires expanded context')],
    }
  if (terminal === 'uncertain')
    return {
      status: 'uncertain',
      evidence: [diagnostic('action-uncertain', 'implement context result is not authenticated')],
    }
  if (terminal === 'ambiguous')
    return {
      status: 'blocked',
      evidence: [diagnostic('ambiguous', 'implement context result has competing successors')],
    }
  return null
}
