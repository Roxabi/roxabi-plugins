import { diagnostic } from './record-diagnostics.ts'
import { classifyAttempts, interruptionGate } from './workflow-action-interruption.ts'
import { assessSpecCompletion } from './workflow-assessment-completion.ts'
import { ciAttributionCompletion, ciInputsMatch } from './workflow-ci-attribution-completion.ts'

export { boundCiAttribution } from './workflow-ci-attribution-completion.ts'

import { selectedContextRecovery } from './workflow-context-recovery.ts'
import { currentContextSuccession } from './workflow-context-succession-current.ts'
import { workflowContextTerminal } from './workflow-context-terminal.ts'
import { type MandateRecord, type ReceiptRecord, recordsOf } from './workflow-control.ts'
import type { WorkflowGraphAction } from './workflow-graph.ts'
import { implementationCompletion } from './workflow-implementation-completion.ts'
import type { ActionCompletion, WorkflowEvidence } from './workflow-plan.ts'
import { planMacro } from './workflow-plan-macro.ts'
import { plannerRecoveryCompletion } from './workflow-planner-recovery.ts'

import type { SpecializedDecisions, WorkflowFacts } from './workflow-reconstruction-types.ts'

export function actionCompletion(
  action: WorkflowGraphAction,
  evidence: WorkflowEvidence,
  decisions: SpecializedDecisions,
  mandate: MandateRecord | null,
  facts: WorkflowFacts | null = null,
): ActionCompletion {
  const context = contextCompletion(action, evidence, mandate, facts)
  if (context !== null) return context
  switch (action) {
    case 'plan':
      return planCompletion(evidence, mandate, facts)
    case 'implement':
      return implementationCompletion(evidence, mandate, facts)
    case 'assess-spec':
      return assessSpecCompletion(evidence, facts, mandate)
    case 'attribute-ci':
      return ciAttributionCompletion(evidence, facts, mandate)
    case 'publish':
      return selectedCompletion(decisions.publish)
    case 'land':
      return selectedCompletion(decisions.landing)
    case 'watch':
      return selectedCompletion(decisions.watch)
    default:
      return receiptCompletion(evidence.issue, action)
  }
}

function contextCompletion(
  action: WorkflowGraphAction,
  evidence: WorkflowEvidence,
  mandate: MandateRecord | null,
  facts: WorkflowFacts | null,
): ActionCompletion | null {
  if (action !== 'frame' && action !== 'assess-spec' && action !== 'attribute-ci') return null
  const histories = [evidence.issue, ...(evidence.pullRequest === null ? [] : [evidence.pullRequest])]
  const classified =
    action === 'frame'
      ? null
      : classifyAttempts({
          histories: [...histories, ...evidence.causal.histories],
          scan: histories,
          actions: [action],
        })
  if (classified !== null && !classified.ok) return { status: 'blocked', evidence: classified.diagnostics }
  const disposition =
    mandate === null
      ? { ok: true as const, value: new Set<string>() }
      : currentContextSuccession(evidence, mandate, facts)
  if (!disposition.ok) return { status: 'blocked', evidence: disposition.diagnostics }
  const excluded = new Set([...(classified?.value.excluded ?? []), ...disposition.value])
  for (const history of histories) {
    const terminal = workflowContextTerminal(history, action, undefined, excluded)
    const decision = contextHistoryDecision(terminal, action, evidence, mandate, facts, classified, excluded)
    if (decision === 'continue') continue
    if (decision !== null) return decision
  }
  return null
}

function contextHistoryDecision(
  terminal: 'clear' | 'missing' | 'uncertain' | 'ambiguous',
  action: WorkflowGraphAction,
  evidence: WorkflowEvidence,
  mandate: MandateRecord | null,
  facts: WorkflowFacts | null,
  classified: Extract<ReturnType<typeof classifyAttempts>, { ok: true }> | null,
  excluded: ReadonlySet<string>,
): ActionCompletion | 'continue' | null {
  if (terminal !== 'clear' && classified !== null) {
    const gate = interruptionGate(classified)
    if (gate.kind === 'stop') return gate.completion
  }
  if (terminal === 'missing' && classified !== null && mandate !== null && facts?.contextRecovery !== undefined) {
    const selected = selectedContextRecovery(evidence, mandate, action, excluded, facts.contextRecovery)
    if (selected !== null && selectedRecoveryReady(action, evidence, mandate, facts, selected)) return 'continue'
  }
  return contextTerminalDecision(action, terminal)
}

function selectedRecoveryReady(
  action: WorkflowGraphAction,
  evidence: WorkflowEvidence,
  mandate: MandateRecord,
  facts: WorkflowFacts,
  selected: ReceiptRecord,
): boolean {
  if (action === 'assess-spec')
    return (
      facts.currentSpec !== null &&
      facts.identityAllocations !== null &&
      assessSpecCompletion(evidence, facts, mandate, selected).status === 'not-started'
    )
  if (action === 'attribute-ci')
    return (
      selected.payload.action === 'attribute-ci' &&
      selected.payload.phase === 'result' &&
      facts.evidenceDigest != null &&
      ciInputsMatch(selected.payload, facts, mandate, facts.evidenceDigest) &&
      ciAttributionCompletion(evidence, facts, mandate).status === 'not-started'
    )
  return false
}

function contextTerminalDecision(
  action: WorkflowGraphAction,
  terminal: 'clear' | 'missing' | 'uncertain' | 'ambiguous',
): ActionCompletion | null {
  if (terminal === 'missing')
    return {
      status: 'blocked',
      evidence: [diagnostic('action-context-missing', `${action} requires expanded context`)],
    }
  if (terminal === 'uncertain')
    return {
      status: 'uncertain',
      evidence: [diagnostic('action-uncertain', `${action} context result is not authenticated`)],
    }
  if (terminal === 'ambiguous')
    return {
      status: 'blocked',
      evidence: [diagnostic('ambiguous', `${action} context result has competing successors`)],
    }
  return null
}

function planCompletion(
  evidence: WorkflowEvidence,
  mandate: MandateRecord | null,
  facts: WorkflowFacts | null,
): ActionCompletion {
  const disposition =
    mandate === null
      ? { ok: true as const, value: new Set<string>() }
      : currentContextSuccession(evidence, mandate, facts)
  if (!disposition.ok) return { status: 'blocked', evidence: disposition.diagnostics }
  const recovery = plannerRecoveryCompletion(evidence, mandate, facts, disposition.value)
  if (recovery !== null) return recovery
  const macro = planMacro(evidence, mandate, { excludedStarts: disposition.value })
  if (macro.phase === 'eligible') return { status: 'confirmed', evidence: macro.evidence }
  if (macro.phase === 'blocked') return { status: 'blocked', evidence: macro.evidence }
  if (macro.phase === 'uncertain') return { status: 'uncertain', evidence: macro.evidence }
  return { status: 'not-started', evidence: macro.evidence }
}

function selectedCompletion(
  selector: SpecializedDecisions['publish'] | SpecializedDecisions['landing'] | SpecializedDecisions['watch'],
): ActionCompletion {
  if (selector.status === 'published' || selector.status === 'not-applicable') {
    return { status: 'confirmed', evidence: selector.evidence }
  }
  if (selector.status === 'uncertain') return { status: 'uncertain', evidence: selector.evidence }
  if (selector.status === 'failed') return { status: 'blocked', evidence: selector.evidence }
  return { status: 'not-started', evidence: selector.evidence }
}

function receiptCompletion(history: WorkflowEvidence['issue'], action: string): ActionCompletion {
  const progress = receiptProgress(history, action)
  if (progress === 'uncertain') {
    return { status: 'uncertain', evidence: [diagnostic('action-uncertain', `${action} started without a result`)] }
  }
  return { status: progress === 'confirmed' ? 'confirmed' : 'not-started', evidence: [] }
}

function receiptProgress(
  history: WorkflowEvidence['issue'],
  action: string,
): 'not-started' | 'confirmed' | 'uncertain' {
  const receipts = recordsOf(history).filter(
    (record): record is ReceiptRecord => record.kind === 'action-receipt' && record.payload.action === action,
  )
  const starts = receipts.filter((record) => record.payload.phase === 'start')
  const results = receipts.filter((record) => record.payload.phase === 'result')
  if (starts.length === 0 && results.length === 0) return 'not-started'
  if (starts.some((start) => !results.some((result) => result.payload.actionId === start.payload.actionId)))
    return 'uncertain'
  return results.length > 0 ? 'confirmed' : 'uncertain'
}
