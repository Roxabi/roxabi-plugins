import type { Scope } from '../engine/record-values.ts'
import type { AdmittedIntegration } from './nested-delivery-integration-admission.ts'
import type { integrationVerdict } from './nested-delivery-integration-verdict.ts'
import { submission } from './record-builders.ts'
import { contribution } from './record-decisions.ts'
import type { epicReviewGraph } from './record-graphs.ts'

type Graph = ReturnType<typeof epicReviewGraph>
type Row = ReturnType<typeof integrationVerdict>

function reviewRoot(graph: Graph) {
  const slots = graph.root.payload.slots.map((slot) =>
    slot.slotId === 'spec-0' ? { ...slot, role: 'R-review-spec' } : slot,
  )
  return { ...graph.root, payload: { ...graph.root.payload, slots } }
}

function specFields(graph: Graph, scope: Scope) {
  return {
    id: graph.spec.recordId,
    scope,
    inventoryId: graph.root.recordId,
    phase: 'spec' as const,
    role: 'R-review-spec' as const,
    slotId: 'spec-0',
    chunk: null,
  }
}

function specContribution(graph: Graph, scope: Scope, row: Row) {
  const structured = { findings: [], specRows: [row] }
  const attempt = submission({ id: `review-${scope.target}`, structuredOutput: { status: 'valid', data: structured } })
  return contribution({ ...specFields(graph, scope), findings: [], structured, rawAttempts: [attempt] })
}

function reviewDecision(graph: Graph, spec: ReturnType<typeof contribution>, admitted: AdmittedIntegration) {
  if (graph.decision.payload.judgment.purpose !== 'review') throw new Error('Expected review decision')
  const judgment = {
    ...graph.decision.payload.judgment,
    criterionVerdicts: [{ contributionId: spec.recordId, target: admitted.target }],
  }
  return { ...graph.decision, payload: { ...graph.decision.payload, judgment } }
}

function synthesisFields(graph: Graph, scope: Scope) {
  return {
    id: graph.synthesisContribution.recordId,
    scope,
    inventoryId: graph.synthesis.recordId,
    phase: 'synthesis' as const,
    role: 'R-synthesis' as const,
    slotId: 'synthesis-0',
    chunk: null,
  }
}

function synthesisContribution(graph: Graph, scope: Scope, decision: ReturnType<typeof reviewDecision>) {
  const structured = decision.payload.judgment
  const attempt = submission({
    id: `synthesis-${scope.target}`,
    structuredOutput: { status: 'valid', data: structured },
  })
  return contribution({ ...synthesisFields(graph, scope), content: 'decision', structured, rawAttempts: [attempt] })
}

export function integrationReviewRecords(graph: Graph, scope: Scope, row: Row, admitted: AdmittedIntegration) {
  const root = reviewRoot(graph)
  const spec = specContribution(graph, scope, row)
  const decision = reviewDecision(graph, spec, admitted)
  const synthesis = synthesisContribution(graph, scope, decision)
  return { decision, records: [root, spec, graph.panel, graph.synthesis, synthesis, decision] }
}
