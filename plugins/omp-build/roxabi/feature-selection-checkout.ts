import { effectiveMandateRole } from '../dist/contracts.js'
import type { MandateRecord } from '../engine/workflow-control.ts'
import type { FeatureAuthority } from './feature-continuation-admission.ts'
import type { SelectedFeature } from './feature-continuation-selection.ts'
import type { ContinueFeatureResult, FeatureControl } from './feature-contract.ts'
import { resolveParentWorktreeAnchor } from './feature-parent-anchor.ts'
import { prepareRequestedSession, prepareSuccessorCheckout } from './feature-selection-session.ts'
import type { UwRead } from './uw-contract.ts'
import { runWorktreeBootstrap, verifyParentCheckout } from './workflow-checkout.ts'

type SelectionState = Pick<FeatureAuthority, 'history' | 'parentHistories' | 'causal' | 'selection'>

export async function prepareSelectionSession(
  control: FeatureControl,
  selected: SelectedFeature,
  branch: string,
  sessionCwd: string | null,
  state: SelectionState,
  assessmentRecovery: boolean,
): Promise<ContinueFeatureResult | null> {
  const { authority, mandate } = selected
  const checked = await verifySelectedCheckout(selected, assessmentRecovery)
  if (checked !== null) return checked
  const requested = control === 'select' || control === 'resume' || control === 'new'
  if (
    !requested ||
    (state.selection.status === 'refused' && state.selection.reason === 'missing' && control === 'select')
  ) {
    return null
  }
  if (!authority.onPrincipal && sessionCwd !== null) {
    const boot = await runWorktreeBootstrap(authority.context.cwd)
    return boot.ok ? null : { kind: 'blocked', reason: boot.reason }
  }
  if (!authority.onPrincipal) return null
  const prepared = await prepareRequestedSession(authority, selectedBranchTarget(authority, mandate, branch))
  if ('kind' in prepared) return prepared
  const boot = await runWorktreeBootstrap(authority.context.cwd)
  return boot.ok ? null : { kind: 'blocked', reason: boot.reason }
}

function selectedBranchTarget(authority: FeatureAuthority, mandate: MandateRecord | null, branch: string) {
  if (mandate !== null && mandate.payload.branch !== null)
    return { kind: 'branch' as const, branch: mandate.payload.branch, attachExisting: true as const }
  if (authority.target.status === 'pull-request')
    return { kind: 'branch' as const, branch, attachExisting: true as const }
  return { kind: 'branch' as const, branch }
}

async function verifySelectedCheckout(
  selected: SelectedFeature,
  assessmentRecovery: boolean,
): Promise<ContinueFeatureResult | null> {
  const { authority, mandate, acceptedSpec, uwRead } = selected
  if ((authority.selection.status !== 'applicable' && !assessmentRecovery) || mandate === null || acceptedSpec === null)
    return null
  const role = effectiveMandateRole(mandate.payload.role, acceptedSpec)
  if (role === 'epic') return verifyEpicCheckout(authority, uwRead)
  if (role !== 'feature') return null
  if (mandate.payload.branch === null) return { kind: 'blocked', reason: 'mandate-checkout-unreadable' }
  return prepareSuccessorCheckout(authority, { kind: 'branch', branch: mandate.payload.branch, attachExisting: true })
}

async function verifyEpicCheckout(
  authority: FeatureAuthority,
  uwRead: UwRead | null,
): Promise<ContinueFeatureResult | null> {
  if (uwRead === null) return { kind: 'blocked', reason: 'uw-read-required' }
  const anchor = await resolveParentWorktreeAnchor({ subject: authority.scope, read: uwRead })
  if (!anchor.ok) return { kind: 'blocked', reason: anchor.reason }
  if (authority.onPrincipal) {
    const prepared = await prepareRequestedSession(authority, { kind: 'parent', uw: anchor.anchor })
    return 'kind' in prepared ? prepared : { kind: 'blocked', reason: 'session-not-intended-worktree' }
  }
  const checked = await verifyParentCheckout({
    git: authority.context.git,
    cwd: authority.context.cwd,
    uw: anchor.anchor,
  })
  return checked.ok ? null : { kind: 'blocked', reason: checked.reason }
}
