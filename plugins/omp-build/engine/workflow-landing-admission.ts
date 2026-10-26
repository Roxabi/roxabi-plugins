import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, sameRef } from './record-diagnostics.ts'
import { specDigest } from './record-digests.ts'
import type { Diagnostic, Scope } from './record-values.ts'
import { resolveAcceptedSpec } from './workflow-accepted-spec.ts'
import {
  abandoned,
  bindExternalRef,
  confirmedPause,
  historyFor,
  type MandateRecord,
  mandateScope,
  outstandingPauseInAuthority,
  successorOf,
  unliftedPause,
} from './workflow-control.ts'
import type { LandingMandateDecision, LandingRefusal } from './workflow-landing.ts'
import type { MandateRefusal } from './workflow-mandate.ts'
import { selectApplicableMandate } from './workflow-mandate-admission.ts'
import { epicParentProblem } from './workflow-parent.ts'
import { selectWorkflowBinding, type WorkflowBindingSelection } from './workflow-pr-binding.ts'

export type LandingMandateInput = {
  histories: readonly DecodedHistory[]
  native: { branch: string; base: string; pullRequest: Scope; linkedIssueScopes: readonly Scope[] }
  parentScopes: readonly Scope[]
  current: {
    productVersion: string
    configVersion: string
    configDigest: string
    supportedConfigVersions: readonly string[]
    specDigest: string | null
    specBody: string | null
  }
  localInhibit: 'pause' | 'abandon' | null
}

type LandingCandidate = { mandate: MandateRecord; home: DecodedHistory }

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

function landingBindingReason(
  selection: Exclude<WorkflowBindingSelection, { status: 'bound' | 'absent' }>,
): LandingRefusal {
  if (selection.status === 'conflicting') return 'conflict'
  if (selection.status === 'incomplete') return 'incomplete'
  return 'unknown-binding'
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

function selectedCandidate(input: LandingMandateInput): LandingCandidate | LandingMandateDecision {
  const selected = selectWorkflowBinding({
    pullRequest: input.native.pullRequest,
    histories: input.histories,
    native: { branch: input.native.branch, base: input.native.base },
  })
  if (selected.status === 'absent')
    return landingRefusal('missing', [diagnostic('missing', 'No workflow binding exists on the pull request')])
  if (selected.status !== 'bound') return landingRefusal(landingBindingReason(selected), selected.diagnostics)
  const home = historyFor(mandateScope(selected.mandateRecord), input.histories)
  if (home === null)
    return landingRefusal('missing-history', [diagnostic('missing-history', 'Mandate history is missing')])
  return { mandate: selected.mandateRecord, home }
}

function directAuthority(candidate: LandingCandidate, input: LandingMandateInput): LandingMandateDecision | null {
  const { mandate, home } = candidate
  const omission = epicParentProblem(mandate, input.histories)
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

function parentAuthority(candidate: LandingCandidate, input: LandingMandateInput): LandingMandateDecision | null {
  const { mandate } = candidate
  if (mandate.payload.parent === null) return null
  const parentHistory = historyFor(mandate.payload.parent.scope, input.histories)
  if (parentHistory === null)
    return landingRefusal('missing-history', [diagnostic('missing-history', 'Parent mandate history is missing')])
  const parent = bindExternalRef(mandate.payload.parent, parentHistory)
  if (!parent.ok) return landingRefusal('incomplete', parent.diagnostics)
  if (parent.value.kind !== 'mandate')
    return landingRefusal('unknown-binding', [diagnostic('kind-mismatch', 'Parent reference is not a mandate')])
  const parentSelection = selectApplicableMandate(parentHistory, input.histories)
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
  return null
}

function currentAuthority(candidate: LandingCandidate, input: LandingMandateInput): LandingMandateDecision | null {
  const { mandate } = candidate
  const outstandingPause = outstandingPauseInAuthority(mandate, input.histories)
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

function acceptedSpecAuthority(candidate: LandingCandidate, input: LandingMandateInput): LandingMandateDecision | null {
  if (input.current.specDigest === null || input.current.specBody === null)
    return landingRefusal('material-spec', [diagnostic('material-spec', 'Current spec body was not supplied')])
  if (specDigest(input.current.specBody) !== input.current.specDigest)
    return landingRefusal('material-spec', [diagnostic('material-spec', 'Current spec digest does not match its body')])
  const accepted = resolveAcceptedSpec(candidate.mandate, input.histories)
  if (!accepted.ok) return landingRefusal(acceptedReason(accepted.reason), accepted.evidence)
  if (input.current.specDigest !== accepted.spec.digest)
    return landingRefusal('materially-changed', [
      diagnostic('materially-changed', 'Live spec differs from the effective approved snapshot'),
    ])
  return null
}

function acceptedReason(reason: 'incomplete' | 'ambiguous' | 'material-spec' | 'missing-history'): LandingRefusal {
  if (reason === 'material-spec') return 'material-spec'
  if (reason === 'ambiguous') return 'ambiguous'
  if (reason === 'missing-history') return 'missing-history'
  return 'incomplete'
}

export function requireLandingMandate(input: LandingMandateInput): LandingMandateDecision {
  void input.native.linkedIssueScopes
  const listed = incompleteListedParent(input.parentScopes, input.histories)
  if (listed !== null) return listed
  const selected = selectedCandidate(input)
  if ('ok' in selected) return selected
  const direct = directAuthority(selected, input)
  if (direct !== null) return direct
  const parent = parentAuthority(selected, input)
  if (parent !== null) return parent
  const current = currentAuthority(selected, input)
  if (current !== null) return current
  const spec = acceptedSpecAuthority(selected, input)
  if (spec !== null) return spec
  return {
    ok: true,
    recordId: selected.mandate.recordId,
    scope: mandateScope(selected.mandate),
    mandate: selected.mandate,
  }
}
