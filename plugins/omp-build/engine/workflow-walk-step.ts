import type { DecodedHistory } from './history-schema.ts'
import { diagnostic } from './record-diagnostics.ts'
import { actionCompletion } from './workflow-action-completion.ts'
import { completionBlockReason } from './workflow-action-state.ts'
import { conditionHolds } from './workflow-condition-evaluation.ts'
import type { MandateRecord } from './workflow-control.ts'
import type { WorkflowGraph } from './workflow-graph.ts'
import type { WorkflowEvidence } from './workflow-plan.ts'
import type { SpecializedDecisions, WorkflowDecision, WorkflowFacts } from './workflow-reconstruction-types.ts'

function blocked(
  reason: Extract<WorkflowDecision, { status: 'blocked' }>['reason'],
  evidence: WorkflowDecision['evidence'],
): WorkflowDecision {
  return { status: 'blocked', reason, evidence }
}

function terminalDecision(
  node: WorkflowGraph['nodes'][number],
  history: DecodedHistory,
  facts: WorkflowFacts,
  decisions: SpecializedDecisions,
  mandate: MandateRecord,
  pullRequest: DecodedHistory | null,
  externalHistories: readonly DecodedHistory[],
): WorkflowDecision | null {
  if (
    node.action === 'stop' &&
    conditionHolds('ci-attribution-refused', history, facts, decisions, mandate, pullRequest, externalHistories) ===
      true
  ) {
    return {
      status: 'terminal',
      reason: 'ci-attribution-refused',
      evidence: [diagnostic('ci-attribution-refused', 'CI attribution refused correction')],
    }
  }
  if (node.action === 'stop' && decisions.reviewStep === 'stop')
    return { status: 'terminal', reason: 'bound-stop', evidence: [diagnostic('bound-stop', 'Review bound is spent')] }
  if (node.action !== 'done') return null
  return facts.endObligationsMet
    ? { status: 'terminal', reason: 'done', evidence: [] }
    : blocked('unknown-outcome', [diagnostic('unknown-outcome', 'Merged work still has end obligations')])
}

function nextNode(
  graph: WorkflowGraph,
  current: string,
  node: WorkflowGraph['nodes'][number],
  history: DecodedHistory,
  facts: WorkflowFacts,
  decisions: SpecializedDecisions,
  mandate: MandateRecord,
  pullRequest: DecodedHistory | null,
  externalHistories: readonly DecodedHistory[],
): string | WorkflowDecision {
  const matching = graph.edges.filter(
    (edge) =>
      edge.from === current &&
      conditionHolds(edge.when, history, facts, decisions, mandate, pullRequest, externalHistories) === true,
  )
  const exclusive = [
    ['spec-differs', 'spec-settled'],
    ['review-step-review', 'review-step-fix', 'review-step-land', 'review-step-stop'],
    ['ci-red', 'ci-attributed-change', 'ci-attribution-refused'],
    [
      'epic-start',
      'epic-resume',
      'epic-stop',
      'epic-final-review',
      'epic-fix-ticket',
      'epic-post-merge',
      'epic-complete',
      'epic-drop',
    ],
  ].some((group) => matching.filter((edge) => group.includes(edge.when)).length > 1)
  if (exclusive)
    return blocked('ambiguous-transition', [
      diagnostic('ambiguous-transition', `Node ${current} has exclusive conditions both true`),
    ])
  const next = matching[0]
  if (next !== undefined) return next.to
  if ((node.action === 'land' || node.action === 'watch') && mandate.payload.permissions.landing === false)
    return blocked('fix-only', [diagnostic('fix-only', 'Fix-only mandate cannot land')])
  return blocked('unknown-outcome', [diagnostic('unknown-outcome', `Node ${current} has no matching edge`)])
}

export function walkWorkflowStep(
  graph: WorkflowGraph,
  nodes: ReadonlyMap<string, WorkflowGraph['nodes'][number]>,
  current: string,
  enteredByTransition: boolean,
  evidence: WorkflowEvidence,
  facts: WorkflowFacts,
  decisions: SpecializedDecisions,
  mandate: MandateRecord,
): string | WorkflowDecision {
  const node = nodes.get(current)
  if (node === undefined)
    return blocked('unsupported-graph', [diagnostic('unsupported-graph', 'Workflow node is missing')])
  const completion = actionCompletion(node.action, evidence, decisions, mandate, facts)
  if (completion.status === 'uncertain') return blocked('action-uncertain', completion.evidence)
  if (completion.status === 'blocked') return blocked(completionBlockReason(completion), completion.evidence)
  const externalHistories = [...evidence.parents, ...(evidence.pullRequest === null ? [] : [evidence.pullRequest])]
  const terminal = terminalDecision(
    node,
    evidence.issue,
    facts,
    decisions,
    mandate,
    evidence.pullRequest,
    externalHistories,
  )
  if (terminal !== null) return terminal
  const next = nextNode(
    graph,
    current,
    node,
    evidence.issue,
    facts,
    decisions,
    mandate,
    evidence.pullRequest,
    externalHistories,
  )
  if (
    enteredByTransition &&
    typeof next !== 'string' &&
    next.status === 'blocked' &&
    next.reason === 'unknown-outcome' &&
    completion.status === 'not-started'
  )
    return {
      status: 'action',
      action: node.action,
      nodeId: node.id,
      mandateId: mandate.recordId,
      evidence: completion.evidence,
    }
  return next
}
