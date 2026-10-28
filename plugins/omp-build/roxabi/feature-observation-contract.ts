import type { UwAdmission } from '../engine/uw-admission.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { WorkflowEvidence } from '../engine/workflow-plan.ts'
import type { SpecializedDecisions, WorkflowFacts } from '../engine/workflow-reconstruction-types.ts'
import type { Delivery } from './feature-delivery-facts.ts'

export type FreshUwDeliveryAdmission = { admission: UwAdmission } | { diagnostics: readonly UwDiagnostic[] } | null

export type FeatureObservation = {
  evidence: WorkflowEvidence
  delivery: Delivery | null
  facts: WorkflowFacts & { lineageHead: string | null }
  deliveryAdmission: FreshUwDeliveryAdmission
  decisions: SpecializedDecisions
  reviewId: string | null
}
