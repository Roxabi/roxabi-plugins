import type { ScopedRecordRef } from '../engine/record-references.ts'
import type { AcceptedOwnSpec } from '../engine/workflow-accepted-spec-types.ts'
import type { MandateRecord } from '../engine/workflow-control.ts'
import { branchFor } from '../skills/feature/epic-naming.ts'
import { mandateParentHistories } from './feature-context.ts'
import type { FeatureAuthority } from './feature-continuation-admission.ts'
import type { ContinueFeatureResult, FeatureControl } from './feature-contract.ts'
import { scopeNumber } from './feature-delivery-facts.ts'
import { establishFirstMandate, freshOwnSpec } from './feature-initial-mandate.ts'
import { prepareRequestedSession, prepareSuccessorCheckout } from './feature-selection-session.ts'
import { publishSuccessorMandate } from './feature-succession.ts'
import { composeObservedUwCausalContext, readFixUwCausalContext } from './fix-uw-histories.ts'
import { withRoxabiGitHubPolicy } from './github-policy.ts'
import type { NormalizationProposalRequest, UwOperations, UwRead, UwReadPort } from './uw-contract.ts'
import { markSuccessorNormalization } from './uw-normalization-internal.ts'
import { readSelectionIssueSpec, type SelectionIssueSpec } from './uw-spec'
import { runWorktreeBootstrap } from './workflow-checkout.ts'

export type SelectedFeature = {
  authority: FeatureAuthority
  number: number
  reader: UwReadPort | null
  issue: SelectionIssueSpec
  uwRead: UwRead | null
  mandate: MandateRecord | null
  acceptedSpec: AcceptedOwnSpec | null
  mandateRef: ScopedRecordRef | null
}

type SelectionState = Pick<FeatureAuthority, 'history' | 'parentHistories' | 'causal' | 'selection'>

export async function selectFeatureMandate(
  control: FeatureControl,
  exactMandateRef: ScopedRecordRef | undefined,
  authority: FeatureAuthority,
  uw?: UwOperations,
  reader: UwReadPort | undefined = uw,
): Promise<SelectedFeature | ContinueFeatureResult> {
  const { context, identity, scope } = authority
  const number = scopeNumber(scope)
  if (number === 0) return { kind: 'blocked', reason: 'issue-unreadable' }
  const issue = await readSelectionIssueSpec(context.cwd, scope.repository, number, context.gh)
  if (issue === null) return { kind: 'blocked', reason: 'issue-unreadable' }
  const uwRead = reader === undefined ? null : await reader.readUw(scope)
  const branch = branchFor({ number, title: issue.title, labels: issue.labels })
  const normalization = selectionNormalization(control, authority, uwRead)
  if (normalization?.kind === 'normalization') {
    const prepared = await prepareRequestedSession(authority, branch)
    return prepared ?? normalization
  }
  if (normalization !== null) return normalization
  const sessionCwd = identity.ok ? identity.sessionTop : null
  const updated = await updateMandateSelection(control, authority, issue, uwRead, uw, number, branch, sessionCwd)
  if ('kind' in updated) return updated
  const prepared = await prepareSelectionSession(control, authority, branch, sessionCwd, updated)
  if (prepared !== null) return prepared
  return finishSelection(authority, updated, exactMandateRef, issue, number, uwRead, reader)
}

async function finishSelection(
  authority: FeatureAuthority,
  updated: SelectionState,
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

function needsInitialSpec(control: FeatureControl, selection: FeatureAuthority['selection']): boolean {
  if (selection.status !== 'refused') return false
  if (selection.reason === 'missing') return control === 'select' || control === 'continue'
  return control === 'new' && (selection.reason === 'abandoned' || selection.reason === 'revoked')
}

export function selectionNormalization(
  control: FeatureControl,
  authority: Pick<FeatureAuthority, 'scope' | 'selection'>,
  read: UwRead | null,
): ContinueFeatureResult | null {
  if (!needsInitialSpec(control, authority.selection)) return null
  if (read === null) return { kind: 'blocked', reason: 'uw-read-required' }
  const { scope } = authority
  const root = read.graph.nodes.find(
    (node) => node.uw.repository === scope.repository && node.uw.target === scope.target,
  )
  if (root === undefined) return { kind: 'blocked', reason: 'graph-root-missing' }
  if (read.parsed.status === 'conformant') return null
  const request: NormalizationProposalRequest = {
    uw: scope,
    title: root.title,
    parsed: read.parsed,
    graph: read.graph,
    writes: {
      labels: { add: [], remove: [] },
      relations: { addChildren: [], removeChildren: [], addBlockers: [], removeBlockers: [] },
    },
  }
  if (
    control === 'new' &&
    authority.selection.status === 'refused' &&
    (authority.selection.reason === 'abandoned' || authority.selection.reason === 'revoked')
  ) {
    markSuccessorNormalization(request, read)
  }
  return { kind: 'normalization', request }
}

async function updateMandateSelection(
  control: FeatureControl,
  authority: FeatureAuthority,
  issue: SelectedFeature['issue'],
  uwRead: UwRead | null,
  reader: UwReadPort | undefined,
  number: number,
  branch: string,
  sessionCwd: string | null,
): Promise<SelectionState | ContinueFeatureResult> {
  let state: SelectionState = authority
  if (
    control === 'new' &&
    state.selection.status === 'refused' &&
    (state.selection.reason === 'abandoned' || state.selection.reason === 'revoked')
  ) {
    const successor = await createSuccessorSelection({
      authority,
      issue,
      uwRead,
      reader,
      number,
      branch,
      sessionCwd,
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
    const established = await establishFirstMandate({ authority, uwRead, reader, branch, history: state.history })
    if ('kind' in established) return established
    state = { ...state, ...established }
  }
  return state
}

async function prepareSelectionSession(
  control: FeatureControl,
  authority: FeatureAuthority,
  branch: string,
  sessionCwd: string | null,
  state: SelectionState,
): Promise<ContinueFeatureResult | null> {
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
  return authority.onPrincipal ? prepareRequestedSession(authority, branch) : null
}

async function createSuccessorSelection(input: {
  authority: FeatureAuthority
  issue: SelectedFeature['issue']
  uwRead: UwRead | null
  number: number
  reader: UwReadPort | undefined
  branch: string
  sessionCwd: string | null
  history: FeatureAuthority['history']
  parentHistories: FeatureAuthority['parentHistories']
}): Promise<SelectionState | ContinueFeatureResult> {
  const { authority, issue, uwRead, reader, number, branch, sessionCwd, history, parentHistories } = input
  if (reader === undefined) return { kind: 'blocked', reason: 'uw-read-required' }
  const own = await freshOwnSpec(authority.scope, uwRead, reader)
  if ('kind' in own) return own
  const checkout = await prepareSuccessorCheckout(authority, branch, sessionCwd)
  if (checkout !== null) return checkout
  const boot = await runWorktreeBootstrap(authority.context.cwd)
  if (!boot.ok) return { kind: 'blocked', reason: boot.reason }
  return publishAndRefreshSuccessor(authority, issue, own, number, history, parentHistories, reader)
}

async function publishAndRefreshSuccessor(
  authority: FeatureAuthority,
  issue: SelectedFeature['issue'],
  own: Pick<MandateRecord['payload'], 'ownSpec' | 'tier' | 'children'>,
  number: number,
  history: FeatureAuthority['history'],
  parentHistories: FeatureAuthority['parentHistories'],
  reader: UwReadPort,
): Promise<SelectionState | ContinueFeatureResult> {
  const { context, scope } = authority
  const succession = await publishSuccessorMandate({
    loaded: context.engine,
    history,
    scope,
    issue,
    ...own,
    number,
    git: context.git,
    gh: context.gh,
    cwd: context.cwd,
    parents: parentHistories,
  })
  if (!succession.ok) return { kind: 'blocked', reason: succession.reason }
  const options = { ...withRoxabiGitHubPolicy({ cwd: context.cwd, gh: context.gh }), gh: context.gh }
  const refreshed = await context.engine.readComposedWorkflowHistory([scope], options)
  if (!refreshed.ok || refreshed.histories[0] === undefined) return { kind: 'blocked', reason: 'successor-unconfirmed' }
  const nextHistory = refreshed.histories[0]
  const parents = await mandateParentHistories(context.engine, nextHistory, options)
  if (!parents.ok) return { kind: 'blocked', reason: parents.reason }
  const read = await reader.readUw(scope)
  const causal = await readFixUwCausalContext(read.histories, [nextHistory, ...parents.parents], options)
  if (!causal.ok)
    return {
      kind: 'blocked',
      reason: causal.diagnostics[0] ?? 'causal-history-unavailable',
      diagnostics: causal.diagnostics.slice(1).map((message) => ({ code: message, message })),
    }
  const selection = context.engine.selectApplicableMandate(nextHistory, parents.parents, causal.value)
  if (selection.status !== 'applicable') {
    return { kind: 'blocked', reason: `successor-${selection.status === 'refused' ? selection.reason : 'unconfirmed'}` }
  }
  return { history: nextHistory, parentHistories: parents.parents, causal: causal.value, selection }
}
