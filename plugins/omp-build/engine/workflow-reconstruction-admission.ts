import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope, sameRef } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { Diagnostic } from './record-values.ts'
import { classifyAttempts, interruptionGate } from './workflow-action-interruption.ts'
import { workflowCausalDiagnostics } from './workflow-chantier.ts'
import {
  abandoned,
  type MandateRecord,
  mandateScope,
  mandatesOf,
  workflowOperationProblem,
} from './workflow-control.ts'
import { executableGraph } from './workflow-graph.ts'
import { INTERRUPTION_ACTIONS } from './workflow-interruption-proof.ts'
import type { MandateSelection } from './workflow-mandate.ts'
import { resolveOwnSpecAuthority, selectApplicableMandate } from './workflow-mandate-admission.ts'
import { confirmedPause, outstandingPauseInAuthority, outstandingPauseRequest } from './workflow-pause.ts'
import type { WorkflowCausalContext, WorkflowEvidence } from './workflow-plan.ts'
import { selectWorkflowBinding } from './workflow-pr-binding.ts'
import { assessmentDecision } from './workflow-reconstruction-assessment.ts'
import type { SpecializedDecisions, WorkflowDecision, WorkflowFacts } from './workflow-reconstruction-types.ts'
import { sessionEvidence, sessionReady } from './workflow-session.ts'
import { walkWorkflow } from './workflow-walk.ts'

type ReconstructionInput = { evidence: WorkflowEvidence; facts: WorkflowFacts; decisions: SpecializedDecisions }
type MandateAdmission = { mandate: MandateRecord } | WorkflowDecision

function blocked(
  reason: Extract<WorkflowDecision, { status: 'blocked' }>['reason'],
  evidence: Diagnostic[],
): WorkflowDecision {
  return { status: 'blocked', reason, evidence }
}

function historyProblemDecision(history: DecodedHistory): WorkflowDecision | null {
  const problem = workflowOperationProblem(history)
  if (problem === 'ambiguous')
    return blocked('ambiguous-transition', [diagnostic('ambiguous', 'Workflow history conflicts')])
  if (problem === 'incompatible-format')
    return blocked(problem, [diagnostic(problem, 'Workflow history uses an incompatible format')])
  if (problem === 'unconfirmed' || problem === 'incomplete')
    return blocked('incomplete', [diagnostic(problem, 'Workflow history is not complete')])
  return null
}

function missingMandateDecision(facts: WorkflowFacts): WorkflowDecision {
  if (!facts.explicitSelection)
    return blocked('mandate-absent', [diagnostic('mandate-absent', 'No mandate exists and selection was not explicit')])
  if (!sessionReady(facts)) return blocked('session-cwd', sessionEvidence(facts))
  return { status: 'action', action: 'frame', nodeId: null, mandateId: null, evidence: [] }
}

function inactiveMandateDecision(
  reason: 'abandoned' | 'revoked',
  history: DecodedHistory,
  facts: WorkflowFacts,
  evidence: Diagnostic[],
): WorkflowDecision {
  if (facts.explicitSelection)
    return blocked('successor-required', [
      diagnostic('successor-required', 'Explicit selection cannot mint a mandate over a revoked one'),
    ])
  if (reason === 'abandoned') {
    return {
      status: 'abandoned',
      mandateId: mandatesOf(history).find((record) => abandoned(history, record))?.recordId ?? 'unknown',
      evidence,
    }
  }
  return blocked('successor-required', evidence)
}

/** An explicit resume never reruns over an unresolved attempt of the paused mandate (issue and pull request). */
function pausedInterruptionDecision(
  mandate: MandateRecord,
  history: DecodedHistory,
  externalHistories: readonly DecodedHistory[],
  causal: WorkflowCausalContext,
): WorkflowDecision | null {
  const mandateRef: ExternalRecordRef = { scope: mandateScope(mandate), recordId: mandate.recordId, kind: 'mandate' }
  const gate = interruptionGate(
    classifyAttempts({
      histories: [history, ...externalHistories, ...causal.histories],
      scan: [history, ...externalHistories],
      actions: INTERRUPTION_ACTIONS,
      select: (receipt) => 'scope' in receipt.payload.mandate && sameRef(receipt.payload.mandate, mandateRef),
    }),
  )
  if (gate.kind === 'clear') return null
  const evidence = gate.completion.evidence
  if (gate.completion.status === 'uncertain') return blocked('action-uncertain', evidence)
  return blocked(evidence[0]?.code === 'action-interrupted' ? 'action-interrupted' : 'interruption-invalid', evidence)
}

function pausedMandateDecision(
  selection: Extract<MandateSelection, { status: 'refused'; reason: 'paused' }>,
  history: DecodedHistory,
  externalHistories: readonly DecodedHistory[],
  causal: WorkflowCausalContext,
  facts: WorkflowFacts,
): WorkflowDecision {
  const ownPause = equalScope(selection.pause.mandate.scope, history.source.scope)
  if (ownPause && (facts.explicitSelection || facts.explicitResume) && sessionReady(facts)) {
    const mandate = mandatesOf(history).find((record) => record.recordId === selection.pause.mandate.recordId)
    if (mandate === undefined)
      return blocked('missing-history', [diagnostic('missing-history', 'Paused mandate is unavailable')])
    const configuration = configurationDecision(mandate, facts)
    if (configuration !== null) return configuration
    const interruption = pausedInterruptionDecision(mandate, history, externalHistories, causal)
    if (interruption !== null) return interruption
    return {
      status: 'action',
      action: 'resume',
      nodeId: null,
      mandateId: selection.pause.mandate.recordId,
      evidence: [],
      pause: selection.pause,
    }
  }
  return {
    status: 'paused',
    mandateId: selection.pause.mandate.recordId,
    confirmed: true,
    evidence: selection.evidence,
    pause: selection.pause,
  }
}

function refusalDecision(selection: Extract<MandateSelection, { status: 'refused' }>): WorkflowDecision {
  const code = selection.evidence[0]?.code
  if (code === 'config-drift') return blocked('config-drift', selection.evidence)
  if (code === 'unsupported-graph') return blocked('unsupported-graph', selection.evidence)
  if (code === 'missing-history' || code === 'incomplete') return blocked('missing-history', selection.evidence)
  if (selection.reason === 'incompatible-format') return blocked(selection.reason, selection.evidence)
  if (selection.reason === 'incompatible' || selection.reason === 'unsafe' || selection.reason === 'materially-changed')
    return blocked('unsafe-authority', selection.evidence)
  return blocked(selection.reason === 'unsupported' ? 'unsupported-config' : 'unconfirmed', selection.evidence)
}

function selectedMandate(
  history: DecodedHistory,
  externalHistories: readonly DecodedHistory[],
  causal: WorkflowCausalContext,
  facts: WorkflowFacts,
): MandateAdmission {
  const own = resolveOwnSpecAuthority(history, externalHistories, causal)
  if (own.ok) return { mandate: own.value.mandate }
  const selection = selectApplicableMandate(history, externalHistories, causal)
  if (selection.status === 'applicable') return { mandate: selection.mandate }
  if (selection.reason === 'missing') return missingMandateDecision(facts)
  if (selection.reason === 'abandoned' || selection.reason === 'revoked')
    return inactiveMandateDecision(selection.reason, history, facts, selection.evidence)
  if (selection.reason === 'paused') return pausedMandateDecision(selection, history, externalHistories, causal, facts)
  return refusalDecision(selection)
}

function localAuthorityDecision(
  mandate: MandateRecord,
  history: DecodedHistory,
  externalHistories: readonly DecodedHistory[],
  facts: WorkflowFacts,
): WorkflowDecision | null {
  if (facts.localInhibit === 'pause' && confirmedPause(history, mandate) === null)
    return blocked('pause-unconfirmed', [
      diagnostic('pause-unconfirmed', 'Pause was inhibited locally but not confirmed'),
    ])
  if (facts.localInhibit === 'abandon' && !abandoned(history, mandate))
    return blocked('unconfirmed', [diagnostic('unconfirmed', 'Abandon was inhibited locally but not confirmed')])
  if (outstandingPauseRequest(history, mandate) !== null)
    return blocked('pause-unconfirmed', [diagnostic('pause-unconfirmed', 'Pause was requested and not confirmed')])
  const outstandingPause = outstandingPauseInAuthority(mandate, [history, ...externalHistories])
  if (outstandingPause !== null) return blocked('pause-unconfirmed', [outstandingPause])
  return configurationDecision(mandate, facts)
}

function configurationDecision(mandate: MandateRecord, facts: WorkflowFacts): WorkflowDecision | null {
  if (facts.productVersion !== mandate.payload.config.productVersion)
    return blocked('config-drift', [diagnostic('config-drift', 'Host product version differs from the mandate')])
  if (!facts.supportedConfigVersions.includes(mandate.payload.config.version))
    return blocked('unsupported-config', [diagnostic('unsupported-config', 'Mandate config version is not supported')])
  if (facts.configDigest !== mandate.payload.config.digest)
    return blocked('config-drift', [diagnostic('config-drift', 'Host config digest differs from the mandate')])
  return null
}

function bindingDecision(
  decision: WorkflowDecision,
  input: ReconstructionInput,
  history: DecodedHistory,
  externalHistories: readonly DecodedHistory[],
  mandate: MandateRecord,
): WorkflowDecision | null {
  if (
    decision.status !== 'action' ||
    (decision.action !== 'land' && decision.action !== 'review' && decision.action !== 'watch') ||
    input.facts.pullRequest === null
  )
    return null
  const selected = selectWorkflowBinding({
    pullRequest: input.facts.pullRequest.scope,
    histories: [history, ...externalHistories],
    native: { branch: input.facts.pullRequest.head, base: input.facts.pullRequest.base },
  })
  if (selected.status === 'bound' && selected.mandateRecord.recordId === mandate.recordId) return null
  return blocked(
    'unknown-binding',
    selected.status === 'bound'
      ? [diagnostic('unknown-binding', 'Workflow binding does not name the active mandate')]
      : selected.status === 'absent'
        ? [diagnostic('missing', 'No workflow binding exists on the pull request')]
        : selected.diagnostics,
  )
}

export function reconstructWorkflow(input: ReconstructionInput): WorkflowDecision {
  const history = input.evidence.issue
  const externalHistories = [input.evidence.pullRequest, ...input.evidence.parents].filter(
    (item): item is DecodedHistory => item !== null,
  )
  const historyProblem = historyProblemDecision(history)
  if (historyProblem !== null) return historyProblem
  const drift = workflowCausalDiagnostics([history, ...externalHistories], input.evidence.causal)
  if (drift.length) return blocked('missing-history', drift)
  const selected = selectedMandate(history, externalHistories, input.evidence.causal, input.facts)
  if (!('mandate' in selected)) return selected
  const local = localAuthorityDecision(selected.mandate, history, externalHistories, input.facts)
  if (local !== null) return local
  if (!sessionReady(input.facts)) return blocked('session-cwd', sessionEvidence(input.facts))
  const assessment = assessmentDecision(history, selected.mandate, input.facts, input.evidence.causal.histories)
  if (assessment !== null) return assessment
  const graph = executableGraph(selected.mandate)
  if (!graph.ok) return blocked('unsupported-graph', graph.diagnostics)
  const decision = walkWorkflow(graph.value, input.evidence, input.facts, input.decisions, selected.mandate)
  if (decision.status === 'action' && decision.action === 'assess-spec') return decision
  const delivery = selectApplicableMandate(history, externalHistories, input.evidence.causal)
  if (delivery.status !== 'applicable') return refusalDecision(delivery)
  return bindingDecision(decision, input, history, externalHistories, selected.mandate) ?? decision
}
