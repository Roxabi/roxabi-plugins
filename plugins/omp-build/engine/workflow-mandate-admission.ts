import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope, fail, sameRef } from './record-diagnostics.ts'
import type { Result } from './result.ts'
import { resolveAcceptedSpec } from './workflow-accepted-spec.ts'
import type { AcceptedOwnSpec, AcceptedSpecResult } from './workflow-accepted-spec-types.ts'
import { workflowCausalDiagnostics } from './workflow-chantier.ts'
import type { HistoricalAcceptedSpecContext } from './workflow-context-succession-inspection.ts'
import {
  bindExternalRef,
  type ControlRecord,
  historyFor,
  type MandateRecord,
  mandateScope,
  refused,
} from './workflow-control.ts'
import { executableGraph } from './workflow-graph.ts'
import type { MandateSelection } from './workflow-mandate.ts'
import { historyRefusal } from './workflow-mandate-history.ts'
import { selectedMandate } from './workflow-mandate-selection.ts'

export { selectedMandate } from './workflow-mandate-selection.ts'

import { epicParentProblem } from './workflow-parent.ts'
import { unliftedPause } from './workflow-pause.ts'
import type { WorkflowCausalContext } from './workflow-plan.ts'
import type { AcceptedSpecInspection, AssessmentReplayContext } from './workflow-spec-authentication.ts'

type MandateRefusalSelection = Extract<MandateSelection, { status: 'refused' }>

function cycleRefusal(history: DecodedHistory, seen: ReadonlySet<string>): MandateRefusalSelection | null {
  const scopeKey = `${history.source.scope.repository}\0${history.source.scope.target}`
  return seen.has(scopeKey) ? refused('ambiguous', [diagnostic('ambiguous', 'Mandate parent chain cycles')]) : null
}

function pauseRefusal(mandate: MandateRecord, pause: ControlRecord): MandateRefusalSelection {
  return {
    status: 'refused',
    reason: 'paused',
    evidence: [diagnostic('paused', `Mandate ${mandate.recordId} is paused`)],
    pause: {
      mandate: { scope: mandateScope(mandate), recordId: mandate.recordId, kind: 'mandate' },
      confirmation: {
        scope: { repository: pause.repository, target: pause.target },
        recordId: pause.recordId,
        kind: 'operator-control',
      },
    },
  }
}
function acceptedRefusal(result: Exclude<AcceptedSpecResult, { ok: true }>): MandateRefusalSelection {
  return refused(
    result.reason === 'ambiguous'
      ? 'ambiguous'
      : result.reason === 'missing-history'
        ? 'missing-history'
        : 'incomplete',
    result.evidence,
  )
}

function permissionRefusal(mandate: MandateRecord, parent: MandateRecord): MandateRefusalSelection | null {
  if (mandate.payload.permissions.landing && !parent.payload.permissions.landing)
    return refused('incompatible', [diagnostic('incompatible', 'Child landing exceeds the parent')])
  if (mandate.payload.permissions.correct && !parent.payload.permissions.correct)
    return refused('incompatible', [diagnostic('incompatible', 'Child correction exceeds the parent')])
  return null
}

export function childCommitmentRefusal(
  mandate: MandateRecord,
  parent: AcceptedOwnSpec,
  child: AcceptedOwnSpec,
): MandateRefusalSelection | null {
  const approved = parent.children.find((commitment) => equalScope(commitment.scope, mandateScope(mandate)))
  if (approved === undefined)
    return refused('unknown-binding', [
      diagnostic('unknown-binding', 'Child scope is not approved by the current accepted parent Spec'),
    ])
  if (approved.specVersion !== child.ref.version || approved.tier !== child.tier)
    return refused('materially-changed', [
      diagnostic(
        'materially-changed',
        'Child accepted Spec version or tier differs from the current parent commitment',
      ),
    ])
  return null
}

function parentPolicyRefusal(
  mandate: MandateRecord,
  parent: MandateRecord,
  causal: WorkflowCausalContext,
  inspection?: AcceptedSpecInspection,
  historical?: HistoricalAcceptedSpecContext,
): MandateSelection | null {
  const permissions = permissionRefusal(mandate, parent)
  if (permissions !== null) return permissions
  const parentAccepted = resolveAcceptedSpec(parent, causal.histories, undefined, inspection, historical)
  if (!parentAccepted.ok) return acceptedRefusal(parentAccepted)
  const childAccepted = resolveAcceptedSpec(mandate, causal.histories, undefined, inspection, historical)
  if (!childAccepted.ok) return acceptedRefusal(childAccepted)
  return childCommitmentRefusal(mandate, parentAccepted.spec, childAccepted.spec)
}

function parentAdmission(
  mandate: MandateRecord,
  externalHistories: readonly DecodedHistory[],
  causal: WorkflowCausalContext,
  seen: ReadonlySet<string>,
  inspection?: AcceptedSpecInspection,
  historical?: HistoricalAcceptedSpecContext,
): MandateSelection | null {
  if (mandate.payload.parent === null) return null
  const parentHistory = historyFor(mandate.payload.parent.scope, externalHistories)
  if (parentHistory === null)
    return refused('incomplete', [diagnostic('missing-history', 'Parent mandate history is missing')])
  const parent = bindExternalRef(mandate.payload.parent, parentHistory)
  if (!parent.ok) return refused('incomplete', parent.diagnostics)
  if (parent.value.kind !== 'mandate')
    return refused('unknown-binding', [diagnostic('kind-mismatch', 'Parent reference is not a mandate')])
  const selectedParent = selectedMandate(parentHistory)
  if ('status' in selectedParent) return selectedParent
  if (
    !sameRef(
      { scope: mandateScope(selectedParent), recordId: selectedParent.recordId, kind: 'mandate' },
      mandate.payload.parent,
    )
  ) {
    return refused('revoked', [diagnostic('revoked', 'Child parent reference does not name the active parent mandate')])
  }
  const parentSelection = selectApplicableMandate(
    parentHistory,
    externalHistories,
    causal,
    seen,
    inspection,
    historical,
  )
  if (parentSelection.status === 'refused') return parentSelection
  const policy = parentPolicyRefusal(mandate, parentSelection.mandate, causal, inspection, historical)
  return policy
}

function mandateAdmission(
  mandate: MandateRecord,
  history: DecodedHistory,
  externalHistories: readonly DecodedHistory[],
  causal: WorkflowCausalContext,
  seen: ReadonlySet<string>,
  inspection?: AcceptedSpecInspection,
  historical?: HistoricalAcceptedSpecContext,
): MandateSelection {
  const pause = unliftedPause(history, mandate)
  if (pause !== null) return pauseRefusal(mandate, pause)
  const graph = executableGraph(mandate)
  if (!graph.ok) return refused('unsupported', graph.diagnostics)
  const omission = epicParentProblem(mandate, [history, ...externalHistories], causal, inspection, historical)
  if (omission !== null) return refused(omission.reason, omission.evidence)
  const parent = parentAdmission(mandate, externalHistories, causal, seen, inspection, historical)
  return parent ?? { status: 'applicable', mandate }
}

export function selectApplicableMandate(
  history: DecodedHistory,
  externalHistories: readonly DecodedHistory[],
  causal: WorkflowCausalContext,
  seen: ReadonlySet<string> = new Set(),
  inspection?: AcceptedSpecInspection,
  historical?: HistoricalAcceptedSpecContext,
): MandateSelection {
  const cycle = cycleRefusal(history, seen)
  if (cycle !== null) return cycle
  const historyProblem = historyRefusal(history)
  if (historyProblem !== null) return historyProblem
  const drift = workflowCausalDiagnostics([history, ...externalHistories], causal)
  if (drift.length) return refused('incomplete', drift)
  const selected = selectedMandate(history)
  if ('status' in selected) return selected
  const nextSeen = new Set(seen)
  nextSeen.add(`${history.source.scope.repository}\0${history.source.scope.target}`)
  return mandateAdmission(selected, history, externalHistories, causal, nextSeen, inspection, historical)
}

export type OwnSpecAuthority = {
  mandate: MandateRecord
  accepted: AcceptedOwnSpec
}

function controlParentAuthority(
  mandate: MandateRecord,
  externalHistories: readonly DecodedHistory[],
  causal: WorkflowCausalContext,
  seen: ReadonlySet<string>,
  replayContext?: AssessmentReplayContext,
  inspection?: AcceptedSpecInspection,
  historical?: HistoricalAcceptedSpecContext,
): Result<void> {
  if (mandate.payload.parent === null) return { ok: true, value: undefined }
  const parentHistory = historyFor(mandate.payload.parent.scope, externalHistories)
  if (parentHistory === null) return fail([diagnostic('missing-history', 'Parent mandate history is missing')])
  const bound = bindExternalRef(mandate.payload.parent, parentHistory)
  if (!bound.ok) return bound
  if (bound.value.kind !== 'mandate') return fail([diagnostic('kind-mismatch', 'Parent reference is not a mandate')])
  const parent = resolveOwnSpecAuthority(
    parentHistory,
    externalHistories,
    causal,
    seen,
    replayContext,
    inspection,
    historical,
  )
  if (!parent.ok) return parent
  if (
    !sameRef(
      { scope: mandateScope(parent.value.mandate), recordId: parent.value.mandate.recordId, kind: 'mandate' },
      mandate.payload.parent,
    )
  )
    return fail([diagnostic('revoked', 'Child parent reference does not name the active parent mandate')])
  if (mandate.payload.permissions.landing && !parent.value.mandate.payload.permissions.landing)
    return fail([diagnostic('incompatible', 'Child landing exceeds the parent')])
  if (mandate.payload.permissions.correct && !parent.value.mandate.payload.permissions.correct)
    return fail([diagnostic('incompatible', 'Child correction exceeds the parent')])
  return { ok: true, value: undefined }
}

/**
 * Resolves the authenticated active mandate and its own accepted Spec for Spec
 * controls. It deliberately excludes delivery-only parent/child commitment
 * concordance so a child can confirm its already-parent-committed proposal.
 */
export function resolveOwnSpecAuthority(
  history: DecodedHistory,
  externalHistories: readonly DecodedHistory[],
  causal: WorkflowCausalContext,
  seen: ReadonlySet<string> = new Set(),
  replayContext?: AssessmentReplayContext,
  inspection?: AcceptedSpecInspection,
  historical?: HistoricalAcceptedSpecContext,
): Result<OwnSpecAuthority> {
  const cycle = cycleRefusal(history, seen)
  if (cycle !== null) return fail(cycle.evidence)
  const historyProblem = historyRefusal(history)
  if (historyProblem !== null) return fail(historyProblem.evidence)
  const drift = workflowCausalDiagnostics([history, ...externalHistories], causal)
  if (drift.length) return fail(drift)
  const selected = selectedMandate(history)
  if ('status' in selected) return fail(selected.evidence)
  const pause = unliftedPause(history, selected)
  if (pause !== null) return fail(pauseRefusal(selected, pause).evidence)
  const graph = executableGraph(selected)
  if (!graph.ok) return fail(graph.diagnostics)
  const nextSeen = new Set(seen)
  nextSeen.add(`${history.source.scope.repository}\0${history.source.scope.target}`)
  const parent = controlParentAuthority(
    selected,
    externalHistories,
    causal,
    nextSeen,
    replayContext,
    inspection,
    historical,
  )
  if (!parent.ok) return parent
  const accepted = resolveAcceptedSpec(selected, causal.histories, replayContext, inspection, historical)
  if (!accepted.ok) return fail(accepted.evidence)
  return { ok: true, value: { mandate: selected, accepted: accepted.spec } }
}
