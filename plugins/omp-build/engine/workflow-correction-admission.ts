import type { DecodedHistory } from './history-schema.ts'
import type { Scope } from './record-values.ts'
import {
  historyFor,
  type MandateRecord,
  mandateScope,
  outstandingPauseInAuthority,
  recordsOf,
  refused,
} from './workflow-control.ts'
import type { FixMandateAssessment } from './workflow-correction-mandate.ts'
import { selectApplicableMandate } from './workflow-mandate-admission.ts'
import { ciAttributionSchema } from './workflow-output-schema.ts'
import { selectWorkflowBinding, type WorkflowBindingSelection } from './workflow-pr-binding.ts'
import { diagnostic, equalScope } from './workflow-support.ts'

export type FixMandateInput = {
  target: { scope: Scope; kind: 'issue' | 'pull-request'; branch: string | null; base: string | null }
  linkedIssueScopes: readonly Scope[]
  history: DecodedHistory
  linkedIssueHistory: DecodedHistory | null
  externalHistories?: readonly DecodedHistory[]
  evidenceDigest?: string | null
}

type BoundSelection = Extract<WorkflowBindingSelection, { status: 'bound' }>

function applicable(mandate: MandateRecord): FixMandateAssessment {
  return { status: 'applicable', mandate, execution: { correct: true, landing: false } }
}

function ciAttributionUnsafe(history: DecodedHistory, evidenceDigest?: string | null): boolean {
  return recordsOf(history).some((record) => {
    if (
      record.kind !== 'action-receipt' ||
      record.payload.action !== 'attribute-ci' ||
      record.payload.phase !== 'result'
    )
      return false
    if (evidenceDigest != null && record.payload.exactInputs.evidenceDigest !== evidenceDigest) return false
    const parsed = ciAttributionSchema.safeParse(record.payload.structured)
    return parsed.success && parsed.data.attribution !== 'change'
  })
}

function pauseAndCiAuthority(
  mandate: MandateRecord,
  histories: readonly DecodedHistory[],
  history: DecodedHistory,
  evidenceDigest?: string | null,
): FixMandateAssessment | null {
  const outstandingPause = outstandingPauseInAuthority(mandate, histories)
  if (outstandingPause !== null) return refused('unconfirmed', [outstandingPause])
  if (ciAttributionUnsafe(history, evidenceDigest))
    return refused('unsafe', [diagnostic('unsafe', 'CI attribution is not the change')])
  return null
}

function correctionAuthority(
  mandate: MandateRecord,
  histories: readonly DecodedHistory[],
  history: DecodedHistory,
  evidenceDigest?: string | null,
): FixMandateAssessment | null {
  if (!mandate.payload.permissions.correct)
    return refused('incompatible', [diagnostic('incompatible', 'Mandate does not permit correction')])
  return pauseAndCiAuthority(mandate, histories, history, evidenceDigest)
}

function boundPullRequestAdmission(
  input: FixMandateInput,
  histories: readonly DecodedHistory[],
  selected: BoundSelection,
): FixMandateAssessment {
  const home = historyFor(selected.mandate.scope, histories)
  if (home === null) return refused('incomplete', [diagnostic('missing-history', 'Bound mandate history is missing')])
  const applicableMandate = selectApplicableMandate(
    home,
    histories.filter((item) => item !== home),
  )
  if (applicableMandate.status === 'refused') return applicableMandate
  const refusal = correctionAuthority(applicableMandate.mandate, histories, input.history, input.evidenceDigest)
  return refusal ?? applicable(applicableMandate.mandate)
}

function unboundPullRequestAdmission(input: FixMandateInput, extra: readonly DecodedHistory[]): FixMandateAssessment {
  const local = selectApplicableMandate(input.history, extra)
  if (local.status === 'refused') return local
  if (local.mandate.payload.role !== 'fix-only' || !equalScope(mandateScope(local.mandate), input.target.scope)) {
    return refused('unknown-binding', [
      diagnostic('unknown-binding', 'A pull request without a binding can only correct an explicit fix-only mandate'),
    ])
  }
  const refusal = pauseAndCiAuthority(local.mandate, [input.history, ...extra], input.history, input.evidenceDigest)
  return refusal ?? applicable(local.mandate)
}

function pullRequestAdmission(input: FixMandateInput, extra: readonly DecodedHistory[]): FixMandateAssessment {
  if (input.target.branch === null || input.target.base === null) {
    return refused('unknown-binding', [diagnostic('unknown-binding', 'Pull request branch or base was not supplied')])
  }
  const histories = [input.history, ...(input.linkedIssueHistory === null ? [] : [input.linkedIssueHistory]), ...extra]
  const selected = selectWorkflowBinding({
    pullRequest: input.target.scope,
    histories,
    native: { branch: input.target.branch, base: input.target.base },
  })
  if (selected.status === 'bound') return boundPullRequestAdmission(input, histories, selected)
  if (selected.status === 'absent') return unboundPullRequestAdmission(input, extra)
  return refused(selected.status === 'conflicting' ? 'ambiguous' : 'incomplete', selected.diagnostics)
}

function issueAdmission(input: FixMandateInput, extra: readonly DecodedHistory[]): FixMandateAssessment {
  const histories = input.linkedIssueHistory === null ? extra : [input.linkedIssueHistory, ...extra]
  const selected = selectApplicableMandate(input.history, histories)
  if (selected.status === 'refused') return selected
  const mandate = selected.mandate
  const pause = outstandingPauseInAuthority(mandate, [input.history, ...histories])
  if (pause !== null) return refused('unconfirmed', [pause])
  if (
    !equalScope(mandateScope(mandate), input.target.scope) &&
    !input.linkedIssueScopes.some((scope) => equalScope(scope, mandateScope(mandate)))
  )
    return refused('unknown-binding', [diagnostic('unknown-binding', 'Mandate scope is not the fix target')])
  if (!mandate.payload.permissions.correct)
    return refused('incompatible', [diagnostic('incompatible', 'Mandate does not permit correction')])
  if (ciAttributionUnsafe(input.history, input.evidenceDigest))
    return refused('unsafe', [diagnostic('unsafe', 'CI attribution is not the change')])
  return applicable(mandate)
}

export function assessFixMandate(input: FixMandateInput): FixMandateAssessment {
  const extra = input.externalHistories ?? []
  return input.target.kind === 'pull-request' ? pullRequestAdmission(input, extra) : issueAdmission(input, extra)
}
