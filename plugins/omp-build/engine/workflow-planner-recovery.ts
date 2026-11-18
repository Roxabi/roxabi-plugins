import { canonicalValueDigest } from './action-input.ts'
import { classifyAttempts, interruptionGate } from './workflow-action-interruption.ts'
import { selectedContextRecovery } from './workflow-context-recovery.ts'
import { type MandateRecord, recordsOf } from './workflow-control.ts'
import { planDigest, planOutputSchema } from './workflow-output-schema.ts'
import type { ActionCompletion, PlanMacro, WorkflowEvidence } from './workflow-plan.ts'
import { planMacro } from './workflow-plan-macro.ts'
import type { ActionReceiptPayload } from './workflow-receipt-schema.ts'
import type { WorkflowFacts } from './workflow-reconstruction-types.ts'

/** Admit only the selected planner leaf into its original semantic slot. */
export function plannerRecoveryCompletion(
  evidence: WorkflowEvidence,
  mandate: MandateRecord | null,
  facts: WorkflowFacts | null,
  excludedStarts?: ReadonlySet<string>,
): ActionCompletion | null {
  if (mandate === null || facts?.contextRecovery === undefined) return null
  const action = facts.contextRecovery.inputs.manifest.purpose
  if (action !== 'plan' && action !== 'plan-review') return null
  const histories = [evidence.issue, ...(evidence.pullRequest === null ? [] : [evidence.pullRequest])]
  const classified = classifyAttempts({
    histories: [...histories, ...evidence.causal.histories],
    scan: histories,
    actions: ['plan', 'plan-review'],
  })
  const gate = interruptionGate(classified)
  if (gate.kind === 'stop') return gate.completion
  const excluded = new Set([...gate.excluded, ...(excludedStarts ?? [])])
  const negative = selectedContextRecovery(evidence, mandate, action, excluded, facts.contextRecovery)
  if (
    negative === null ||
    negative.payload.phase !== 'result' ||
    (negative.payload.action !== 'plan' && negative.payload.action !== 'plan-review')
  )
    return null
  const blocked = planMacro(evidence, mandate, { excludedStarts })
  if (
    blocked.phase !== 'blocked' ||
    blocked.evidence.length === 0 ||
    blocked.evidence.some((item) => item.code !== 'action-context-missing')
  )
    return null
  const macro = planMacro(evidence, mandate, { contextLeaf: negative, excludedStarts })
  if (
    negative.payload.exactInputs.mandateId !== mandate.recordId ||
    negative.payload.exactInputs.specDigest !== macro.specDigest
  )
    return null
  if (!matchesPlannerSlot(negative.payload, macro, evidence)) return null
  return { status: 'not-started', evidence: macro.evidence }
}

function matchesPlannerSlot(
  payload: Extract<ActionReceiptPayload, { action: 'plan' | 'plan-review'; phase: 'result' }>,
  macro: PlanMacro,
  evidence: WorkflowEvidence,
): boolean {
  if (payload.action === 'plan') {
    const exact = payload.exactInputs
    return exact.amendsReviewActionId === null
      ? macro.phase === 'needs-draft'
      : macro.phase === 'needs-amendment' &&
          macro.reviewActionId === exact.amendsReviewActionId &&
          canonicalValueDigest(macro.blockers) === canonicalValueDigest(exact.requiredBlockers)
  }
  const exact = payload.exactInputs
  if (macro.phase !== 'needs-review' || macro.draftActionId !== exact.draftActionId) return false
  const drafts = recordsOf(evidence.issue).filter(
    (record) =>
      record.kind === 'action-receipt' &&
      record.payload.action === 'plan' &&
      record.payload.phase === 'result' &&
      record.payload.actionId === exact.draftActionId,
  )
  const draft = drafts[0]
  if (draft?.kind !== 'action-receipt' || draft.payload.phase !== 'result' || drafts.length !== 1) return false
  const parsed = planOutputSchema.safeParse(draft.payload.structured)
  return parsed.success && planDigest(parsed.data) === exact.planDigest
}
