import { effectiveMandateRole } from '../dist/contracts.js'
import type { ScopedRecordRef } from '../engine/record-references.ts'
import type { AcceptedOwnSpec } from '../engine/workflow-accepted-spec-types.ts'
import type { MandateRecord } from '../engine/workflow-control.ts'
import { branchFor } from '../skills/feature/epic-naming.ts'
import type { FeatureAuthority } from './feature-continuation-admission.ts'
import type { ContinueFeatureResult, FeatureControl } from './feature-contract.ts'
import { scopeNumber } from './feature-delivery-facts.ts'
import { establishFirstMandate } from './feature-initial-mandate.ts'
import { resolveParentWorktreeAnchor } from './feature-parent-anchor.ts'
import { prepareRequestedSession, prepareSuccessorCheckout } from './feature-selection-session.ts'
import { specEntrySelection } from './feature-selection-spec-entry.ts'
import { createSuccessorSelection } from './feature-selection-successor.ts'
import { composeObservedUwCausalContext } from './fix-uw-histories.ts'
import type { UwOperations, UwRead, UwReadPort } from './uw-contract.ts'
import { readSelectionIssueSpec, type SelectionIssueSpec } from './uw-spec'
import { runWorktreeBootstrap, verifyParentCheckout } from './workflow-checkout.ts'

export type SelectedFeature = {
  authority: FeatureAuthority
  number: number
  reader: UwReadPort | null
  issue: SelectionIssueSpec
  uwRead: UwRead | null
  mandate: MandateRecord | null
  acceptedSpec: AcceptedOwnSpec | null
  mandateRef: ScopedRecordRef | null
  /** This call published the UW's first Mandate, consuming any supplied initial coverage intent. */
  firstMandateEstablished: boolean
}

type SelectionState = Pick<FeatureAuthority, 'history' | 'parentHistories' | 'causal' | 'selection'>

export async function selectFeatureMandate(
  control: FeatureControl,
  exactMandateRef: ScopedRecordRef | undefined,
  authority: FeatureAuthority,
  uw?: UwOperations,
  reader: UwReadPort | undefined = uw,
  parentCoverage?: import('../engine/workflow-mandate-schema.ts').ParentCoverage | null,
  parentCoverageBasis?: import('./feature-contract.ts').ParentCoverageRequest,
): Promise<SelectedFeature | ContinueFeatureResult> {
  const { context, identity, scope } = authority
  const number = scopeNumber(scope)
  if (number === 0) return { kind: 'blocked', reason: 'issue-unreadable' }
  const issue = await readSelectionIssueSpec(context.cwd, scope.repository, number, context.gh)
  if (issue === null) return { kind: 'blocked', reason: 'issue-unreadable' }
  const uwRead = reader === undefined ? null : await reader.readUw(scope)
  const branch =
    authority.target.status === 'pull-request'
      ? authority.target.pullRequest.branch
      : branchFor({ number, title: issue.title, labels: issue.labels })
  const entry = specEntrySelection(control, authority, uwRead)
  if (entry !== null) return entry
  const sessionCwd = identity.ok ? identity.sessionTop : null
  const updated = await updateMandateSelection(
    control,
    authority,
    uwRead,
    reader,
    branch,
    parentCoverage,
    parentCoverageBasis,
  )
  if ('kind' in updated) return updated
  const selected = await finishSelection(authority, updated, exactMandateRef, issue, number, uwRead, reader)
  if ('kind' in selected) return selected
  const prepared = await prepareSelectionSession(control, selected, branch, sessionCwd, updated.state)
  return prepared ?? selected
}

async function finishSelection(
  authority: FeatureAuthority,
  { state: updated, firstMandateEstablished }: { state: SelectionState; firstMandateEstablished: boolean },
  exactMandateRef: ScopedRecordRef | undefined,
  issue: SelectionIssueSpec,
  number: number,
  uwRead: UwRead | null,
  reader: UwReadPort | undefined,
): Promise<SelectedFeature | ContinueFeatureResult> {
  const { context, scope } = authority
  const currentRead =
    reader !== undefined && updated.history !== authority.history ? await reader.readUw(scope) : uwRead
  const causal =
    currentRead === null
      ? updated.causal
      : await composeObservedUwCausalContext(currentRead, [updated.history, ...updated.parentHistories], {
          cwd: context.cwd,
          gh: context.gh,
        })
  if ('ok' in causal && !causal.ok)
    return {
      kind: 'blocked',
      reason: causal.diagnostics[0] ?? 'causal-history-unavailable',
      diagnostics: causal.diagnostics.slice(1).map((message) => ({ code: message, message })),
    }
  const selectionCausal = 'ok' in causal ? causal.value : causal
  const applicable = context.engine.selectApplicableMandate(updated.history, updated.parentHistories, selectionCausal)
  const exactProblem = exactSelectionProblem(applicable, exactMandateRef)
  if (exactProblem !== null) return exactProblem
  const own = context.engine.resolveOwnSpecAuthority(updated.history, updated.parentHistories, selectionCausal)
  const mandate = own.ok ? own.value.mandate : null
  const mandateRef: ScopedRecordRef | null =
    exactMandateRef ?? (mandate === null ? null : { scope, recordId: mandate.recordId, kind: 'mandate' })
  return {
    authority: { ...authority, ...updated, causal: selectionCausal, selection: applicable },
    number,
    reader: reader ?? null,
    issue,
    uwRead: currentRead,
    mandate,
    acceptedSpec: own.ok ? own.value.accepted : null,
    mandateRef,
    firstMandateEstablished,
  }
}

function exactSelectionProblem(
  selection: FeatureAuthority['selection'],
  ref: ScopedRecordRef | undefined,
): ContinueFeatureResult | null {
  if (ref === undefined) return null
  if (selection.status !== 'applicable') return { kind: 'blocked', reason: `exact-mandate-${selection.reason}` }
  if (selection.mandate === null || selection.mandate.recordId !== ref.recordId)
    return { kind: 'blocked', reason: 'exact-mandate-not-applicable' }
  return null
}

async function updateMandateSelection(
  control: FeatureControl,
  authority: FeatureAuthority,
  uwRead: UwRead | null,
  reader: UwReadPort | undefined,
  branch: string,
  parentCoverage?: import('../engine/workflow-mandate-schema.ts').ParentCoverage | null,
  parentCoverageBasis?: import('./feature-contract.ts').ParentCoverageRequest,
): Promise<{ state: SelectionState; firstMandateEstablished: boolean } | ContinueFeatureResult> {
  let state: SelectionState = authority
  if (
    control === 'new' &&
    state.selection.status === 'refused' &&
    (state.selection.reason === 'abandoned' || state.selection.reason === 'revoked')
  ) {
    const successor = await createSuccessorSelection({
      authority,
      uwRead,
      reader,
      branch,
      ...state,
    })
    if ('kind' in successor) return successor
    state = successor
  }
  if (
    state.selection.status === 'refused' &&
    state.selection.reason === 'missing' &&
    (control === 'select' || control === 'continue')
  ) {
    const established = await establishFirstMandate({
      authority,
      uwRead,
      reader,
      branch,
      history: state.history,
      parentCoverage,
      parentCoverageBasis,
    })
    if ('kind' in established) return established
    return { state: { ...state, ...established }, firstMandateEstablished: true }
  }
  return { state, firstMandateEstablished: false }
}

async function prepareSelectionSession(
  control: FeatureControl,
  selected: SelectedFeature,
  branch: string,
  sessionCwd: string | null,
  state: SelectionState,
): Promise<ContinueFeatureResult | null> {
  const { authority, mandate } = selected
  const checked = await verifySelectedCheckout(selected)
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

async function verifySelectedCheckout(selected: SelectedFeature): Promise<ContinueFeatureResult | null> {
  const { authority, mandate, acceptedSpec, uwRead } = selected
  if (authority.selection.status !== 'applicable' || mandate === null || acceptedSpec === null) return null
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
