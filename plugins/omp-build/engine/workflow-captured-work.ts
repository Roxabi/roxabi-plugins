import type { Result } from './result.ts'
import { inspectCapturedDeliveries } from './workflow-captured-delivery.ts'
import { inventoryCapturedWork } from './workflow-captured-inventory.ts'
import { inspectCapturedPlans } from './workflow-captured-plan.ts'
import type { WorkflowEvidence } from './workflow-plan.ts'
import type { AssessmentReplayContext } from './workflow-spec-authentication.ts'

/** Closure of immutable old invocations only; never current plan, effect or delivery authority. */
export function inspectCapturedWorkForAssessment(
  evidence: WorkflowEvidence,
  replay?: AssessmentReplayContext,
): Result<void> {
  const inventory = inventoryCapturedWork(evidence, replay)
  if (!inventory.ok) return inventory
  const plans = inspectCapturedPlans(inventory.value, evidence.causal.histories, replay)
  if (!plans.ok) return plans
  return inspectCapturedDeliveries(inventory.value, evidence.causal.histories, replay)
}
