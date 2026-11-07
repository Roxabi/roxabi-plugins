import type { DecodedHistory } from './history-schema.ts'
import { diagnostic } from './record-diagnostics.ts'
import { historyFor, type MandateRecord, mandateScope } from './workflow-control.ts'
import type { LandingMandateDecision, LandingRefusal } from './workflow-landing.ts'
import type { LandingMandateInput } from './workflow-landing-admission.ts'
import { selectWorkflowBinding, type WorkflowBindingSelection } from './workflow-pr-binding.ts'

export type LandingCandidate = { mandate: MandateRecord; home: DecodedHistory }

function landingBindingReason(
  selection: Exclude<WorkflowBindingSelection, { status: 'bound' | 'absent' }>,
): LandingRefusal {
  if (selection.status === 'conflicting') return 'conflict'
  if (selection.status === 'incompatible-format') return 'incompatible-format'
  if (selection.status === 'incomplete') return 'incomplete'
  return 'unknown-binding'
}

export function selectedCandidate(input: LandingMandateInput): LandingCandidate | LandingMandateDecision {
  const selected = selectWorkflowBinding({
    pullRequest: input.native.pullRequest,
    histories: input.authorityHistories,
    native: { branch: input.native.branch, base: input.native.base },
  })
  if (selected.status === 'absent')
    return {
      ok: false,
      reason: 'missing',
      evidence: [diagnostic('missing', 'No workflow binding exists on the pull request')],
    }
  if (selected.status !== 'bound')
    return { ok: false, reason: landingBindingReason(selected), evidence: selected.diagnostics }
  const home = historyFor(mandateScope(selected.mandateRecord), input.authorityHistories)
  if (home === null)
    return {
      ok: false,
      reason: 'missing-history',
      evidence: [diagnostic('missing-history', 'Mandate history is missing')],
    }
  return { mandate: selected.mandateRecord, home }
}
