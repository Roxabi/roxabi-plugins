import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, sameRef } from './record-diagnostics.ts'
import type { Diagnostic, Scope } from './record-values.ts'
import type { ReviewClassCatalogues } from './review-class-catalogue.ts'
import {
  type AcceptedOwnSpecResult,
  assessUwAdmission,
  type CurrentChildrenProjection,
  type ProposedOwnSpecResult,
} from './uw-admission.ts'
import { assessUwCompletion } from './uw-completion.ts'
import type { UwCompletionObservation } from './uw-completion-types.ts'
import { toDiagnostics } from './uw-diagnostics.ts'
import type { UwGraphObservation } from './uw-graph.ts'
import { resolveSpecIdentityLedger } from './uw-identity.ts'
import { resolveAcceptedSpec } from './workflow-accepted-spec.ts'
import { workflowCausalDiagnostics } from './workflow-chantier.ts'
import {
  abandoned,
  bindExternalRef,
  historyFor,
  type MandateRecord,
  mandateScope,
  successorOf,
} from './workflow-control.ts'
import type { LandingMandateDecision, LandingRefusal } from './workflow-landing.ts'
import { type LandingCandidate, selectedCandidate } from './workflow-landing-binding.ts'
import type { MandateRefusal } from './workflow-mandate.ts'
import { childCommitmentRefusal, selectApplicableMandate } from './workflow-mandate-admission.ts'
import { epicParentProblem } from './workflow-parent.ts'
import { confirmedPause, outstandingPauseInAuthority, unliftedPause } from './workflow-pause.ts'
import type { WorkflowCausalContext } from './workflow-plan.ts'

export type LandingMandateInput = {
  histories: readonly DecodedHistory[]
  authorityHistories: readonly DecodedHistory[]
  catalogues: ReviewClassCatalogues
  native: { branch: string; base: string; pullRequest: Scope; linkedIssueScopes: readonly Scope[] }
  parentScopes: readonly Scope[]
  uwGraph: UwGraphObservation
  observation: UwCompletionObservation
  current: {
    productVersion: string
    configVersion: string
    configDigest: string
    supportedConfigVersions: readonly string[]
    proposedSpec: ProposedOwnSpecResult
    currentChildren: CurrentChildrenProjection
  }
  localInhibit: 'pause' | 'abandon' | null
}

function landingRefusal(reason: LandingRefusal, evidence: Diagnostic[]): LandingMandateDecision {
  return { ok: false, reason, evidence }
}

function incompleteListedParent(
  scopes: readonly Scope[],
  histories: readonly DecodedHistory[],
): LandingMandateDecision | null {
  for (const scope of scopes) {
    const history = historyFor(scope, histories)
    if (history !== null && !history.source.complete)
      return landingRefusal('incomplete', [diagnostic('incomplete', 'A listed parent history is incomplete')])
  }
  return null
}

function landingReason(reason: MandateRefusal): LandingRefusal {
  switch (reason) {
    case 'config-invalid':
      return 'unsupported'
    case 'missing':
    case 'paused':
    case 'abandoned':
    case 'revoked':
    case 'unsupported':
    case 'ambiguous':
    case 'incompatible-format':
    case 'incomplete':
    case 'unconfirmed':
    case 'unknown-binding':
    case 'incompatible':
    case 'unsafe':
    case 'materially-changed':
    case 'missing-history':
      return reason
  }
}

function directAuthority(
  candidate: LandingCandidate,
  input: LandingMandateInput,
  causal: WorkflowCausalContext,
): LandingMandateDecision | null {
  const { mandate, home } = candidate
  const omission = epicParentProblem(mandate, input.authorityHistories, causal)
  if (omission !== null) return landingRefusal(landingReason(omission.reason), omission.evidence)
  if (input.localInhibit !== null && confirmedPause(home, mandate) === null && !abandoned(home, mandate))
    return landingRefusal('unconfirmed', [diagnostic('unconfirmed', 'Local inhibit has no confirmed control record')])
  if (mandate.payload.role === 'fix-only' || mandate.payload.permissions.landing === false)
    return landingRefusal('fix-only', [diagnostic('fix-only', 'Fix-only mandate cannot land')])
  if (abandoned(home, mandate))
    return landingRefusal('abandoned', [diagnostic('abandoned', `Mandate ${mandate.recordId} is abandoned`)])
  if (successorOf(home, mandate) !== null)
    return landingRefusal('revoked', [diagnostic('revoked', `Mandate ${mandate.recordId} was superseded`)])
  if (unliftedPause(home, mandate) !== null)
    return landingRefusal('paused', [diagnostic('paused', `Mandate ${mandate.recordId} is paused`)])
  if (mandate.payload.branch === null || mandate.payload.branch !== input.native.branch)
    return landingRefusal('unknown-binding', [diagnostic('unknown-binding', 'Mandate branch does not match')])
  if (mandate.payload.base !== input.native.base)
    return landingRefusal('unknown-binding', [diagnostic('unknown-binding', 'Mandate base does not match')])
  return null
}

function acceptedReason(reason: 'incomplete' | 'ambiguous' | 'material-spec' | 'missing-history'): LandingRefusal {
  if (reason === 'material-spec') return 'material-spec'
  if (reason === 'ambiguous') return 'ambiguous'
  if (reason === 'missing-history') return 'missing-history'
  return 'incomplete'
}

function parentAuthority(
  candidate: LandingCandidate,
  input: LandingMandateInput,
  causal: WorkflowCausalContext,
): LandingMandateDecision | null {
  const { mandate } = candidate
  if (mandate.payload.parent === null) return null
  const parentHistory = historyFor(mandate.payload.parent.scope, input.authorityHistories)
  if (parentHistory === null)
    return landingRefusal('missing-history', [diagnostic('missing-history', 'Parent mandate history is missing')])
  const parent = bindExternalRef(mandate.payload.parent, parentHistory)
  if (!parent.ok) return landingRefusal('incomplete', parent.diagnostics)
  if (parent.value.kind !== 'mandate')
    return landingRefusal('unknown-binding', [diagnostic('kind-mismatch', 'Parent reference is not a mandate')])
  const parentSelection = selectApplicableMandate(parentHistory, input.authorityHistories, causal)
  if (parentSelection.status === 'refused')
    return landingRefusal(landingReason(parentSelection.reason), parentSelection.evidence)
  if (
    !sameRef(
      { scope: mandateScope(parentSelection.mandate), recordId: parentSelection.mandate.recordId, kind: 'mandate' },
      mandate.payload.parent,
    )
  ) {
    return landingRefusal('revoked', [
      diagnostic('revoked', 'Child parent reference does not name the active parent mandate'),
    ])
  }
  if (mandate.payload.permissions.landing && !parent.value.payload.permissions.landing)
    return landingRefusal('incompatible', [diagnostic('incompatible', 'Child landing exceeds the parent')])
  return parentChildGrantRefusal(mandate, parent.value, input.histories)
}

function parentChildGrantRefusal(
  mandate: MandateRecord,
  parent: MandateRecord,
  histories: readonly DecodedHistory[],
): LandingMandateDecision | null {
  const parentAccepted = resolveAcceptedSpec(parent, histories)
  if (!parentAccepted.ok) return landingRefusal(acceptedReason(parentAccepted.reason), parentAccepted.evidence)
  const childAccepted = resolveAcceptedSpec(mandate, histories)
  if (!childAccepted.ok) return landingRefusal(acceptedReason(childAccepted.reason), childAccepted.evidence)
  const grant = childCommitmentRefusal(mandate, parentAccepted.spec, childAccepted.spec)
  return grant === null ? null : landingRefusal(landingReason(grant.reason), grant.evidence)
}

function currentAuthority(candidate: LandingCandidate, input: LandingMandateInput): LandingMandateDecision | null {
  const { mandate } = candidate
  const outstandingPause = outstandingPauseInAuthority(mandate, input.authorityHistories)
  if (outstandingPause !== null) return landingRefusal('unconfirmed', [outstandingPause])
  if (
    input.current.supportedConfigVersions.length === 0 ||
    !input.current.supportedConfigVersions.includes(mandate.payload.config.version)
  )
    return landingRefusal('unsupported', [diagnostic('unsupported', 'Mandate config version is not supported')])
  if (mandate.payload.config.productVersion !== input.current.productVersion)
    return landingRefusal('config-drift', [
      diagnostic('config-drift', 'Mandate product version differs from the installed package'),
    ])
  if (
    mandate.payload.config.version !== input.current.configVersion ||
    mandate.payload.config.digest !== input.current.configDigest
  )
    return landingRefusal('config-drift', [
      diagnostic('config-drift', 'Mandate config digest differs from current config'),
    ])
  return null
}

function uwAdmissionAuthority(candidate: LandingCandidate, input: LandingMandateInput): LandingMandateDecision | null {
  const ownUw = candidate.mandate.payload.ownSpec.uw
  if (input.uwGraph.root.repository !== ownUw.repository || input.uwGraph.root.target !== ownUw.target)
    return landingRefusal('uw-not-deliverable', [
      diagnostic('graph-incomplete', 'Fresh native graph is not rooted at the selected own UW'),
    ])
  if (
    input.observation.status !== 'complete' ||
    input.observation.root.repository !== ownUw.repository ||
    input.observation.root.target !== ownUw.target
  )
    return landingRefusal('uw-not-deliverable', [
      diagnostic(
        'observation-mismatch',
        'Landing must use the same complete graph and histories as its completion observation',
      ),
    ])
  const ownHistory = historyFor(ownUw, input.histories)
  if (ownHistory === null)
    return landingRefusal('missing-history', [diagnostic('missing-history', 'Own UW identity history is missing')])
  const resolved = resolveAcceptedSpec(candidate.mandate, input.histories)
  if (!resolved.ok) return landingRefusal(acceptedReason(resolved.reason), resolved.evidence)
  const accepted: AcceptedOwnSpecResult = { status: 'accepted', value: resolved.spec }
  const identities = resolveSpecIdentityLedger({
    uw: ownUw,
    history: ownHistory,
    histories: input.histories,
    accepted: resolved.spec,
  })
  if (!identities.ok) return landingRefusal('uw-not-deliverable', toDiagnostics(identities.diagnostics))
  const admission = assessUwAdmission({
    uw: ownUw,
    graph: input.uwGraph,
    proposed: input.current.proposedSpec,
    accepted,
    identities: identities.value,
    histories: input.histories,
    catalogues: input.catalogues,
    completion: assessUwCompletion(input.observation),
    phase: 'landing',
    currentChildren: input.current.currentChildren,
  })
  if (!admission.deliverable.ok)
    return landingRefusal('uw-not-deliverable', toDiagnostics(admission.deliverable.diagnostics))
  return null
}

export function requireLandingMandate(input: LandingMandateInput): LandingMandateDecision {
  if (input.observation.status !== 'complete')
    return landingRefusal('incomplete', toDiagnostics(input.observation.diagnostics))
  if (
    JSON.stringify(input.observation.graph) !== JSON.stringify(input.uwGraph) ||
    JSON.stringify(input.observation.histories) !== JSON.stringify(input.histories)
  )
    return landingRefusal('uw-not-deliverable', [
      diagnostic(
        'observation-mismatch',
        'Landing must use the same complete graph and histories as its completion observation',
      ),
    ])
  const causal: WorkflowCausalContext = {
    histories: input.histories,
    catalogues: input.catalogues,
    observation: input.observation,
  }
  const causalDiagnostics = workflowCausalDiagnostics(input.authorityHistories, causal)
  if (causalDiagnostics.length > 0) return landingRefusal('incomplete', causalDiagnostics)
  const listed = incompleteListedParent(input.parentScopes, input.authorityHistories)
  if (listed !== null) return listed
  const selected = selectedCandidate(input)
  if ('ok' in selected) return selected
  const direct = directAuthority(selected, input, causal)
  if (direct !== null) return direct
  const parent = parentAuthority(selected, input, causal)
  if (parent !== null) return parent
  const current = currentAuthority(selected, input)
  if (current !== null) return current
  const uw = uwAdmissionAuthority(selected, input)
  if (uw !== null) return uw
  return {
    ok: true,
    recordId: selected.mandate.recordId,
    scope: mandateScope(selected.mandate),
    mandate: selected.mandate,
  }
}
