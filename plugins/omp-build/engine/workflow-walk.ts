import { diagnostic, sameRef } from './record-diagnostics.ts'
import { completionBlockReason } from './workflow-action-state.ts'
import { inspectCapturedWorkForAssessment } from './workflow-captured-work.ts'
import { conditionHolds } from './workflow-condition-evaluation.ts'
import { unresolvedAssessmentWork, unresolvedWork } from './workflow-conditions.ts'
import type { MandateRecord } from './workflow-control.ts'
import type { WorkflowGraph } from './workflow-graph.ts'
import { resolveOwnSpecAuthority } from './workflow-mandate-admission.ts'
import type { WorkflowEvidence } from './workflow-plan.ts'
import type { SpecializedDecisions, WorkflowDecision, WorkflowFacts } from './workflow-reconstruction-types.ts'
import { walkWorkflowStep } from './workflow-walk-step.ts'

function blocked(
  reason: Extract<WorkflowDecision, { status: 'blocked' }>['reason'],
  evidence: WorkflowDecision['evidence'],
): WorkflowDecision {
  return { status: 'blocked', reason, evidence }
}

export function walkWorkflow(
  graph: WorkflowGraph,
  evidence: WorkflowEvidence,
  facts: WorkflowFacts,
  decisions: SpecializedDecisions,
  mandate: MandateRecord,
): WorkflowDecision {
  const candidate = walkGraph(graph, evidence, facts, decisions, mandate)
  if (
    candidate.status === 'action' &&
    candidate.action === 'assess-spec' &&
    conditionHolds('spec-differs', evidence.issue, facts, decisions, mandate, evidence.pullRequest, evidence.causal) ===
      true
  ) {
    const control = resolveOwnSpecAuthority(
      evidence.issue,
      evidence.causal.histories.filter((history) => history !== evidence.issue),
      evidence.causal,
    )
    if (!control.ok) return blocked('unconfirmed', control.diagnostics)
    const ref = (record: MandateRecord) => ({
      scope: { repository: record.repository, target: record.target },
      kind: 'mandate' as const,
      recordId: record.recordId,
    })
    if (!sameRef(ref(control.value.mandate), ref(mandate)))
      return blocked('unconfirmed', [
        diagnostic('unconfirmed', 'Assessment does not bind the authenticated own mandate'),
      ])
    const captured = inspectCapturedWorkForAssessment(evidence)
    if (!captured.ok) return blocked('unconfirmed', captured.diagnostics)
    const unresolved = unresolvedAssessmentWork(evidence, facts, decisions, mandate)
    return unresolved === null ? candidate : blocked(completionBlockReason(unresolved), unresolved.evidence)
  }
  const unresolved = unresolvedWork(evidence, facts, decisions, mandate)
  return unresolved === null ? candidate : blocked(completionBlockReason(unresolved), unresolved.evidence)
}

function walkGraph(
  graph: WorkflowGraph,
  evidence: WorkflowEvidence,
  facts: WorkflowFacts,
  decisions: SpecializedDecisions,
  mandate: MandateRecord,
): WorkflowDecision {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]))
  let current = graph.initial
  let enteredByTransition = false
  const visited = new Set<string>()
  for (let guard = 0; guard < graph.nodes.length + 1; guard += 1) {
    if (visited.has(current)) return blocked('cycle', [diagnostic('cycle', 'Workflow traversal repeated a node')])
    visited.add(current)
    const next = walkWorkflowStep(graph, nodes, current, enteredByTransition, evidence, facts, decisions, mandate)
    if (typeof next !== 'string') return next
    current = next
    enteredByTransition = true
  }
  return blocked('cycle', [diagnostic('cycle', 'Workflow traversal did not finish')])
}
