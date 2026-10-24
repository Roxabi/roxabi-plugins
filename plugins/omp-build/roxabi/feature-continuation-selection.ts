import type { ScopedRecordRef } from '../engine/record-references.ts'
import type { MandateRecord } from '../engine/workflow-control.ts'
import { branchFor, hasScope } from '../skills/feature/epic-naming.ts'
import { mandateParentHistories, readIssue } from './feature-context.ts'
import type { FeatureAuthority } from './feature-continuation-admission.ts'
import type { ContinueFeatureResult, FeatureControl } from './feature-contract.ts'
import { scopeNumber } from './feature-delivery-facts.ts'
import { publishFirstMandate, resolveBase } from './feature-mandate.ts'
import { linkedMove } from './feature-selection.ts'
import { publishSuccessorMandate } from './feature-succession.ts'
import { prepareFeatureCheckout, runWorktreeBootstrap } from './workflow-checkout.ts'

export type SelectedFeature = {
  authority: FeatureAuthority
  number: number
  issue: NonNullable<Awaited<ReturnType<typeof readIssue>>>
  mandate: MandateRecord | null
  mandateRef: ScopedRecordRef | null
}

type SelectionState = Pick<FeatureAuthority, 'history' | 'parentHistories' | 'selection'>

export async function selectFeatureMandate(
  control: FeatureControl,
  exactMandateRef: ScopedRecordRef | undefined,
  authority: FeatureAuthority,
): Promise<SelectedFeature | ContinueFeatureResult> {
  const { context, identity, scope } = authority
  const number = scopeNumber(scope)
  if (number === 0) return { kind: 'blocked', reason: 'issue-unreadable' }
  const issue = await readIssue(context.gh, context.cwd, scope.repository, number)
  if (issue === null) return { kind: 'blocked', reason: 'issue-unreadable' }
  const sessionCwd = identity.ok ? identity.sessionTop : null
  const branch = branchFor({ number, title: issue.title, labels: issue.labels })
  const updated = await updateMandateSelection(control, authority, issue, number, branch, sessionCwd)
  if ('kind' in updated) return updated
  const prepared = await prepareSelectionSession(control, authority, branch, sessionCwd, updated)
  if (prepared !== null) return prepared
  const applicable =
    exactMandateRef === undefined
      ? context.engine.selectApplicableMandate(updated.history, updated.parentHistories)
      : updated.selection
  const mandate = applicable.status === 'applicable' ? applicable.mandate : null
  const mandateRef: ScopedRecordRef | null =
    exactMandateRef ?? (mandate === null ? null : { scope, recordId: mandate.recordId, kind: 'mandate' })
  return {
    authority: { ...authority, ...updated },
    number,
    issue,
    mandate,
    mandateRef,
  }
}

async function updateMandateSelection(
  control: FeatureControl,
  authority: FeatureAuthority,
  issue: SelectedFeature['issue'],
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
      number,
      branch,
      sessionCwd,
      ...state,
    })
    if ('kind' in successor) return successor
    state = successor
  }
  if (state.selection.status === 'refused' && state.selection.reason === 'missing' && control === 'select') {
    const established = await establishFirstMandate({ authority, issue, number, branch, history: state.history })
    if ('kind' in established) return established
    state = { ...state, history: established.history }
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
  number: number
  branch: string
  sessionCwd: string | null
  history: FeatureAuthority['history']
  parentHistories: FeatureAuthority['parentHistories']
}): Promise<SelectionState | ContinueFeatureResult> {
  const { authority, issue, number, branch, sessionCwd, history, parentHistories } = input
  const checkout = await prepareSuccessorCheckout(authority, branch, sessionCwd)
  if (checkout !== null) return checkout
  const boot = await runWorktreeBootstrap(authority.context.cwd)
  if (!boot.ok) return { kind: 'blocked', reason: boot.reason }
  return publishAndRefreshSuccessor(authority, issue, number, history, parentHistories)
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

async function establishFirstMandate(input: {
  authority: FeatureAuthority
  issue: NonNullable<Awaited<ReturnType<typeof readIssue>>>
  number: number
  branch: string
  history: FeatureAuthority['history']
}): Promise<{ history: FeatureAuthority['history'] } | ContinueFeatureResult> {
  const { authority, issue, number, branch, history } = input
  const { context, identity, scope } = authority
  if (!hasScope({ labels: issue.labels, body: issue.body })) return { kind: 'operator-decision', reason: 'needs-scope' }
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
  if (prepared.status !== 'ready') return { kind: 'blocked', reason: 'session-not-intended-worktree' }
  const boot = await runWorktreeBootstrap(context.cwd)
  if (!boot.ok) return { kind: 'blocked', reason: boot.reason }
  const published = await publishFirstMandate(
    context.engine,
    history,
    scope,
    issue,
    number,
    context.git,
    context.gh,
    context.cwd,
  )
  if (!published.ok) return { kind: 'blocked', reason: published.reason, diagnostics: published.diagnostics }
  const refreshed = await context.engine.readComposedWorkflowHistory([scope], { cwd: context.cwd, gh: context.gh })
  return { history: refreshed.ok && refreshed.histories[0] !== undefined ? refreshed.histories[0] : history }
}

async function prepareRequestedSession(
  authority: FeatureAuthority,
  branch: string,
): Promise<ContinueFeatureResult | null> {
  const { context, identity, scope } = authority
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
  if (prepared.status !== 'ready') return { kind: 'blocked', reason: 'session-not-intended-worktree' }
  const boot = await runWorktreeBootstrap(context.cwd)
  return boot.ok ? null : { kind: 'blocked', reason: boot.reason }
}
