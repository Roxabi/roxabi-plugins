import type { WorkflowGraph } from '../engine/workflow-graph.ts'

export type { WorkflowCondition, WorkflowGraph, WorkflowGraphAction } from '../engine/workflow-graph.ts'

/**
 * Shipped Roxabi lifecycle data. The engine validates this graph and is the
 * only traversal. This module does not match edges.
 */
export const WORKFLOW_CONFIG_VERSION = 'omp-build-workflow/1'
export const SUPPORTED_CONFIG_VERSIONS = [WORKFLOW_CONFIG_VERSION] as const

const NODES: WorkflowGraph['nodes'] = [
  { id: 'ready', action: 'stop' },
  { id: 'frame', action: 'frame' },
  { id: 'assess-spec', action: 'assess-spec' },
  { id: 'plan', action: 'plan' },
  { id: 'implement', action: 'implement' },
  { id: 'publish', action: 'publish' },
  { id: 'review', action: 'review' },
  { id: 'fix', action: 'fix' },
  { id: 'attribute-ci', action: 'attribute-ci' },
  { id: 'land', action: 'land' },
  // Watch attachment is owned by `land` (featureLandOutcome start-watch /
  // reattach-watch). A separate watch node had no incoming edge and is removed
  // rather than inventing a fake condition.
  { id: 'epic-next', action: 'epic-next' },
  { id: 'epic-final', action: 'epic-final' },
  { id: 'mark-fix', action: 'mark-fix' },
  { id: 'hook', action: 'hook' },
  { id: 'report', action: 'report' },
  { id: 'stop', action: 'stop' },
  { id: 'done', action: 'done' },
]

/** One edge per condition. Array order is shipped data the engine validates, not a second matcher. */
const EDGES: WorkflowGraph['edges'] = [
  { from: 'ready', to: 'stop', when: 'ci-attribution-refused' },
  { from: 'ready', to: 'stop', when: 'epic-stop' },
  { from: 'ready', to: 'report', when: 'epic-drop' },
  { from: 'ready', to: 'report', when: 'epic-complete' },
  { from: 'ready', to: 'epic-final', when: 'epic-final-review' },
  { from: 'ready', to: 'mark-fix', when: 'epic-fix-ticket' },
  { from: 'ready', to: 'hook', when: 'epic-post-merge' },
  { from: 'ready', to: 'epic-next', when: 'epic-start' },
  { from: 'ready', to: 'epic-next', when: 'epic-resume' },
  { from: 'ready', to: 'attribute-ci', when: 'ci-red' },
  { from: 'ready', to: 'fix', when: 'ci-attributed-change' },
  { from: 'ready', to: 'stop', when: 'review-step-stop' },
  { from: 'ready', to: 'fix', when: 'review-step-fix' },
  { from: 'ready', to: 'land', when: 'review-step-land' },
  { from: 'ready', to: 'review', when: 'review-step-review' },
  { from: 'ready', to: 'done', when: 'end-obligations-met' },
  { from: 'ready', to: 'hook', when: 'merged' },
  { from: 'ready', to: 'review', when: 'fix-confirmed' },
  { from: 'ready', to: 'review', when: 'pr-open' },
  { from: 'ready', to: 'publish', when: 'implement-confirmed' },
  { from: 'ready', to: 'implement', when: 'plan-confirmed' },
  { from: 'ready', to: 'assess-spec', when: 'spec-differs' },
  { from: 'ready', to: 'plan', when: 'spec-settled' },
  { from: 'ready', to: 'plan', when: 'mandate-ready' },
  { from: 'ready', to: 'frame', when: 'no-mandate' },
  { from: 'ready', to: 'stop', when: 'always' },
]

export const workflowGraphData: Pick<WorkflowGraph, 'nodes' | 'edges'> = { nodes: NODES, edges: EDGES }

export function shippedWorkflowGraph(productVersion: string): WorkflowGraph {
  if (productVersion.length === 0) throw new Error('workflow graph requires the shipped product version')
  return {
    version: 1,
    productVersion,
    configVersion: WORKFLOW_CONFIG_VERSION,
    edgeOrder: 'array',
    nodes: NODES.map((node) => ({ ...node })),
    edges: EDGES.map((edge) => ({ ...edge })),
    initial: 'ready',
  }
}
