import { completionBlockReason } from './workflow-action-state.ts'
import { unresolvedWork } from './workflow-conditions.ts'
import type { MandateRecord } from './workflow-control.ts'
import type { WorkflowGraph } from './workflow-graph.ts'
import type { WorkflowEvidence } from './workflow-plan.ts'
import type { SpecializedDecisions, WorkflowDecision, WorkflowFacts } from './workflow-reconstruction-types.ts'
import { diagnostic } from './workflow-support.ts'
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
  const unresolved = unresolvedWork(evidence, facts, decisions, mandate)
  if (unresolved !== null) return blocked(completionBlockReason(unresolved), unresolved.evidence)
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]))
  let current = graph.initial
  const visited = new Set<string>()
  for (let guard = 0; guard < graph.nodes.length + 1; guard += 1) {
    if (visited.has(current)) return blocked('cycle', [diagnostic('cycle', 'Workflow traversal repeated a node')])
    visited.add(current)
    const next = walkWorkflowStep(graph, nodes, current, evidence, facts, decisions, mandate)
    if (typeof next !== 'string') return next
    current = next
  }
  return blocked('cycle', [diagnostic('cycle', 'Workflow traversal did not finish')])
}
