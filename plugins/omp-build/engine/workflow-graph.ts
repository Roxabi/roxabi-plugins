import { z } from 'zod'
import { diagnostic, fail } from './record-diagnostics.ts'
import type { Result } from './result.ts'
import type { MandateRecord } from './workflow-control.ts'

export const workflowGraphActionSchema = z.enum([
  'frame',
  'assess-spec',
  'plan',
  'implement',
  'publish',
  'proof',
  'review',
  'fix',
  'attribute-ci',
  'land',
  'watch',
  'epic-next',
  'epic-final',
  'mark-fix',
  'hook',
  'report',
  'stop',
  'done',
])
export type WorkflowGraphAction = z.infer<typeof workflowGraphActionSchema>
export const workflowConditionSchema = z.enum([
  'always',
  'no-mandate',
  'mandate-ready',
  'spec-differs',
  'spec-settled',
  'plan-confirmed',
  'implement-confirmed',
  'pr-open',
  'proof-confirmed',
  'review-step-review',
  'review-step-fix',
  'review-step-land',
  'review-step-stop',
  'fix-confirmed',
  'ci-red',
  'ci-attributed-change',
  'ci-attribution-refused',
  'merged',
  'end-obligations-met',
  'epic-start',
  'epic-resume',
  'epic-stop',
  'epic-final-review',
  'epic-fix-ticket',
  'epic-post-merge',
  'epic-complete',
  'epic-drop',
])
export type WorkflowCondition = z.infer<typeof workflowConditionSchema>
export const workflowGraphSchema = z.strictObject({
  version: z.literal(1),
  productVersion: z.string().min(1),
  configVersion: z.string().min(1),
  edgeOrder: z.literal('array'),
  nodes: z.array(z.strictObject({ id: z.string().min(1), action: workflowGraphActionSchema })).min(1),
  edges: z.array(
    z.strictObject({
      from: z.string().min(1),
      to: z.string().min(1),
      when: workflowConditionSchema,
    }),
  ),
  initial: z.string().min(1),
})
export type WorkflowGraph = z.infer<typeof workflowGraphSchema>

export function validateWorkflowGraph(graph: unknown): Result<WorkflowGraph> {
  const parsed = workflowGraphSchema.safeParse(graph)
  if (!parsed.success)
    return fail([
      diagnostic(
        'unsupported-graph',
        'Workflow graph is not in the closed schema',
        parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      ),
    ])
  const ids = parsed.data.nodes.map((node) => node.id)
  if (new Set(ids).size !== ids.length)
    return fail([diagnostic('unsupported-graph', 'Workflow graph repeats a node id')])
  if (!ids.includes(parsed.data.initial))
    return fail([diagnostic('unsupported-graph', 'Workflow graph initial node is missing')])
  const seenEdges = new Set<string>()
  for (const edge of parsed.data.edges) {
    if (!ids.includes(edge.from) || !ids.includes(edge.to))
      return fail([diagnostic('unsupported-graph', 'Workflow graph edge names a missing node')])
    if (edge.from === edge.to) return fail([diagnostic('unsupported-graph', 'Workflow graph edge loops on one node')])
    const key = `${edge.from}\0${edge.to}\0${edge.when}`
    if (seenEdges.has(key)) return fail([diagnostic('unsupported-graph', 'Workflow graph repeats an edge')])
    seenEdges.add(key)
  }
  return { ok: true, value: parsed.data }
}

export function executableGraph(mandate: MandateRecord): Result<WorkflowGraph> {
  const effective = mandate.payload.config.effective
  if (typeof effective !== 'object' || effective === null || Array.isArray(effective))
    return fail([diagnostic('unsupported-graph', 'Mandate effective config has no graph')])
  const parsed = validateWorkflowGraph(Reflect.get(effective, 'graph'))
  if (!parsed.ok) return parsed
  if (parsed.value.productVersion !== mandate.payload.config.productVersion)
    return fail([diagnostic('config-drift', 'Mandate graph product version differs from the mandate')])
  if (parsed.value.configVersion !== mandate.payload.config.version)
    return fail([diagnostic('config-drift', 'Mandate graph config version differs from the mandate')])
  return parsed
}
