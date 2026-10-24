import type { WorkflowEvidence } from '../engine/workflow-plan.ts'
import type { SpecializedDecisions, WorkflowFacts } from '../engine/workflow-reconstruction-types.ts'
import type { Delivery } from './feature-delivery-facts.ts'

export type FeatureObservation = {
  evidence: WorkflowEvidence
  delivery: Delivery | null
  facts: WorkflowFacts & { lineageHead: string | null }
  decisions: SpecializedDecisions
  reviewId: string | null
}
