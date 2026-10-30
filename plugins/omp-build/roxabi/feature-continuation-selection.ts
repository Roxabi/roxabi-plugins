import type { ScopedRecordRef } from '../engine/record-references.ts'
import type { AcceptedOwnSpec } from '../engine/workflow-accepted-spec-types.ts'
import type { MandateRecord } from '../engine/workflow-control.ts'
import { branchFor } from '../skills/feature/epic-naming.ts'
import { mandateParentHistories } from './feature-context.ts'
import type { FeatureAuthority } from './feature-continuation-admission.ts'
import type { ContinueFeatureResult, FeatureControl } from './feature-contract.ts'
import { scopeNumber } from './feature-delivery-facts.ts'
import { establishFirstMandate, freshOwnSpec } from './feature-initial-mandate.ts'
import { resolveBase } from './feature-mandate.ts'
import { linkedMove } from './feature-selection.ts'
import { prepareRequestedSession } from './feature-selection-session.ts'
import { publishSuccessorMandate } from './feature-succession.ts'
import type { NormalizationProposalRequest, UwOperations, UwRead, UwReadPort } from './uw-contract.ts'
import { markSuccessorNormalization } from './uw-normalization-internal.ts'
import { readSelectionIssueSpec, type SelectionIssueSpec } from './uw-spec'
import { prepareFeatureCheckout, runWorktreeBootstrap } from './workflow-checkout.ts'

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

type SelectionState = Pick<FeatureAuthority, 'history' | 'parentHistories' | 'selection'>

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
  const applicable =
    exactMandateRef === undefined
      ? context.engine.selectApplicableMandate(updated.history, updated.parentHistories)
      : updated.selection
  const own = context.engine.resolveOwnSpecAuthority(updated.history, updated.parentHistories)
  const mandate = own.ok ? own.value.mandate : null
  const mandateRef: ScopedRecordRef | null =
    exactMandateRef ?? (mandate === null ? null : { scope, recordId: mandate.recordId, kind: 'mandate' })
  return {
    authority: { ...authority, ...updated, selection: applicable },
    number,
    reader: reader ?? null,
    issue,
    uwRead,
    mandate,
    acceptedSpec: own.ok ? own.value.accepted : null,
    mandateRef,
  }
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
  const own = await freshOwnSpec(authority.scope, uwRead, reader)
  if ('kind' in own) return own
  const checkout = await prepareSuccessorCheckout(authority, branch, sessionCwd)
  if (checkout !== null) return checkout
  const boot = await runWorktreeBootstrap(authority.context.cwd)
  if (!boot.ok) return { kind: 'blocked', reason: boot.reason }
  return publishAndRefreshSuccessor(authority, issue, own, number, history, parentHistories)
}

async function prepareSuccessorCheckout(
  authority: FeatureAuthority,
  branch: string,
  sessionCwd: string | null,
): Promise<ContinueFeatureResult | null> {
  const { context, identity, onPrincipal, scope } = authority
  if (!onPrincipal && sessionCwd !== null) return null
  const base = await resolveBase(context.git, identity.ok ? identity.principalTop : context.cwd)
  if ('reason' in base) return { kind: 'blocked', reason: base.reason }
  const prepared = await prepareFeatureCheckout({
    git: context.git,
    sessionCwd: context.cwd,
    branch,
    base: base.base,
    repository: scope.repository,
    detached: false,
  })
  if (prepared.status === 'blocked') return { kind: 'blocked', reason: prepared.reason }
  if (prepared.status === 'move') {
    const move = linkedMove(context.cwd, prepared.path)
    if (move) return move
  }
  return null
}

async function publishAndRefreshSuccessor(
  authority: FeatureAuthority,
  issue: SelectedFeature['issue'],
  own: Pick<MandateRecord['payload'], 'ownSpec' | 'tier' | 'children'>,
  number: number,
  history: FeatureAuthority['history'],
  parentHistories: FeatureAuthority['parentHistories'],
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
  const refreshed = await context.engine.readComposedWorkflowHistory([scope], { cwd: context.cwd, gh: context.gh })
  if (!refreshed.ok || refreshed.histories[0] === undefined) return { kind: 'blocked', reason: 'successor-unconfirmed' }
  const nextHistory = refreshed.histories[0]
  const parents = await mandateParentHistories(context.engine, nextHistory, { cwd: context.cwd, gh: context.gh })
  if (!parents.ok) return { kind: 'blocked', reason: parents.reason }
  const selection = context.engine.selectApplicableMandate(nextHistory, parents.parents)
  if (selection.status !== 'applicable') {
    return { kind: 'blocked', reason: `successor-${selection.status === 'refused' ? selection.reason : 'unconfirmed'}` }
  }
  return { history: nextHistory, parentHistories: parents.parents, selection }
}
