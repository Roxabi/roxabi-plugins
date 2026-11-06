import { canonicalValueDigest } from '../dist/contracts.js'
import { projectNativeUwChildren } from '../engine/uw-child-admission.ts'
import type { MandateRecord } from '../engine/workflow-control.ts'
import { checkoutTarget } from './feature-checkout-target.ts'
import { mandateParentHistories } from './feature-context.ts'
import type { FeatureAuthority } from './feature-continuation-admission.ts'
import type { ContinueFeatureResult } from './feature-contract.ts'
import { freshOwnSpec } from './feature-initial-mandate.ts'
import { resolveParentWorktreeAnchor } from './feature-parent-anchor.ts'
import { prepareSuccessorCheckout } from './feature-selection-session.ts'
import { publishSuccessorMandate, successionAntecedent } from './feature-succession.ts'
import { composeObservedUwCausalContext } from './fix-uw-histories.ts'
import { withRoxabiGitHubPolicy } from './github-policy.ts'
import type { UwRead, UwReadPort } from './uw-contract.ts'
import type { FeatureCheckoutTarget } from './workflow-checkout.ts'
import { runWorktreeBootstrap, verifyParentCheckout } from './workflow-checkout.ts'

type SelectionState = Pick<FeatureAuthority, 'history' | 'parentHistories' | 'causal' | 'selection'>

export async function createSuccessorSelection(input: {
  authority: FeatureAuthority
  uwRead: UwRead | null
  reader: UwReadPort | undefined
  branch: string
  history: FeatureAuthority['history']
  parentHistories: FeatureAuthority['parentHistories']
}): Promise<SelectionState | ContinueFeatureResult> {
  const { authority, uwRead, reader, history, parentHistories } = input
  if (reader === undefined || uwRead === null) return { kind: 'blocked', reason: 'uw-read-required' }
  const own = await freshOwnSpec(authority.scope, uwRead, reader)
  if ('kind' in own) return own
  const antecedent = successionAntecedent(history)
  if ('reason' in antecedent) return { kind: 'blocked', reason: antecedent.reason }
  const projected = checkoutTarget({
    uw: authority.scope,
    graph: uwRead.graph,
    accepted: uwRead.accepted,
    branch: antecedent.mandate.payload.branch ?? input.branch,
  })
  if ('kind' in projected) return projected
  const anchor = await resolveParentWorktreeAnchor({ subject: authority.scope, read: uwRead })
  if (!anchor.ok) return { kind: 'blocked', reason: anchor.reason }
  if (projected.target.kind === 'parent') projected.target.uw = anchor.anchor
  const parentCheck = await ensureSuccessorParent(authority, uwRead, projected.target, anchor.anchor)
  if (parentCheck !== null) return parentCheck
  if (
    projected.target.kind === 'branch' &&
    authority.target.status === 'pull-request' &&
    projected.target.branch !== authority.target.pullRequest.branch
  )
    return { kind: 'blocked', reason: 'successor-branch-mismatch' }
  const target: FeatureCheckoutTarget =
    projected.target.kind === 'branch' && authority.target.status === 'pull-request'
      ? { ...projected.target, attachExisting: true }
      : projected.target
  const boot = await bootstrapSuccessor(authority, target)
  if ('kind' in boot) return boot
  const confirmed = await confirmSuccessorAfterBootstrap({
    authority,
    reader,
    own,
    history,
    parentHistories,
    target,
    anchor: anchor.anchor,
    head: boot.head,
    branch: boot.branch,
  })
  if ('kind' in confirmed) return confirmed
  return publishAndRefreshSuccessor(authority, own, target, confirmed.history, confirmed.parents, reader)
}

async function bootstrapSuccessor(
  authority: FeatureAuthority,
  target: FeatureCheckoutTarget,
): Promise<{ head: string; branch: string } | ContinueFeatureResult> {
  const checkout = await prepareSuccessorCheckout(authority, target)
  if (checkout !== null) return checkout
  const beforeHead = await authority.context.git(authority.context.cwd, ['rev-parse', '--verify', 'HEAD'])
  const beforeBranch = await authority.context.git(authority.context.cwd, ['branch', '--show-current'])
  if (beforeHead.code !== 0 || !/^[0-9a-f]{40}$/.test(beforeHead.stdout.trim()) || beforeBranch.code !== 0)
    return { kind: 'blocked', reason: 'successor-checkout-unreadable' }
  const boot = await runWorktreeBootstrap(authority.context.cwd)
  if (!boot.ok) return { kind: 'blocked', reason: boot.reason }
  return { head: beforeHead.stdout.trim(), branch: beforeBranch.stdout.trim() }
}

async function ensureSuccessorParent(
  authority: FeatureAuthority,
  uwRead: UwRead,
  target: FeatureCheckoutTarget,
  anchor: FeatureAuthority['scope'],
): Promise<ContinueFeatureResult | null> {
  const root = uwRead.graph.nodes.find(
    (node) => node.uw.repository === authority.scope.repository && node.uw.target === authority.scope.target,
  )
  if (root === undefined) return { kind: 'blocked', reason: 'graph-root-missing' }
  if (target.kind === 'branch' && root.parent !== null) {
    if (authority.onPrincipal) {
      const move = await prepareSuccessorCheckout(authority, { kind: 'parent', uw: anchor })
      return move ?? { kind: 'blocked', reason: 'session-not-intended-worktree' }
    }
    const checked = await verifyParentCheckout({
      git: authority.context.git,
      cwd: authority.context.cwd,
      uw: anchor,
    })
    if (!checked.ok) return { kind: 'blocked', reason: checked.reason }
  }
  return null
}

async function confirmSuccessorAfterBootstrap(input: {
  authority: FeatureAuthority
  reader: UwReadPort
  own: Pick<MandateRecord['payload'], 'ownSpec' | 'tier' | 'children' | 'inheritedOwnSpecRefs' | 'coverage'>
  history: FeatureAuthority['history']
  parentHistories: FeatureAuthority['parentHistories']
  target: FeatureCheckoutTarget
  anchor: FeatureAuthority['scope']
  head: string
  branch: string
}): Promise<
  { history: FeatureAuthority['history']; parents: FeatureAuthority['parentHistories'] } | ContinueFeatureResult
> {
  const { authority, reader, own, history, parentHistories } = input
  const latest = await reader.readUw(authority.scope)
  const children = projectNativeUwChildren({ uw: authority.scope, graph: latest.graph, accepted: latest.accepted })
  if (!children.ok) return { kind: 'blocked', reason: 'uw-children-unconfirmed', diagnostics: children.diagnostics }
  if (children.value.length > 0 !== (input.target.kind === 'parent'))
    return { kind: 'blocked', reason: 'successor-framing-changed' }
  const current = await freshOwnSpec(authority.scope, latest, reader)
  if ('kind' in current) return current
  if (canonicalValueDigest(current) !== canonicalValueDigest(own))
    return { kind: 'blocked', reason: 'successor-framing-changed' }
  const anchor = await resolveParentWorktreeAnchor({ subject: authority.scope, read: latest })
  if (!anchor.ok) return { kind: 'blocked', reason: anchor.reason }
  if (canonicalValueDigest(anchor.anchor) !== canonicalValueDigest(input.anchor))
    return { kind: 'blocked', reason: 'successor-framing-changed' }
  const checkout = await confirmSuccessorCheckout(authority, input.target, input.head, input.branch)
  if (checkout !== null) return checkout
  const options = {
    ...withRoxabiGitHubPolicy({ cwd: authority.context.cwd, gh: authority.context.gh }),
    gh: authority.context.gh,
  }
  const histories = await authority.context.engine.readComposedWorkflowHistory([authority.scope], options)
  if (!histories.ok || histories.histories[0] === undefined) return { kind: 'blocked', reason: 'successor-unconfirmed' }
  const freshHistory = histories.histories[0]
  const parents = await mandateParentHistories(authority.context.engine, freshHistory, options)
  if (!parents.ok) return { kind: 'blocked', reason: parents.reason }
  if (
    canonicalValueDigest(freshHistory) !== canonicalValueDigest(history) ||
    canonicalValueDigest(parents.parents) !== canonicalValueDigest(parentHistories)
  )
    return { kind: 'blocked', reason: 'successor-ancestry-changed' }
  return { history: freshHistory, parents: parents.parents }
}

async function confirmSuccessorCheckout(
  authority: FeatureAuthority,
  target: FeatureCheckoutTarget,
  head: string,
  branch: string,
): Promise<ContinueFeatureResult | null> {
  const afterHead = await authority.context.git(authority.context.cwd, ['rev-parse', '--verify', 'HEAD'])
  const afterBranch = await authority.context.git(authority.context.cwd, ['branch', '--show-current'])
  if (
    afterHead.code !== 0 ||
    afterBranch.code !== 0 ||
    afterHead.stdout.trim() !== head ||
    afterBranch.stdout.trim() !== branch
  )
    return { kind: 'blocked', reason: 'successor-checkout-changed' }
  if (target.kind === 'parent') {
    const checked = await verifyParentCheckout({
      git: authority.context.git,
      cwd: authority.context.cwd,
      uw: target.uw,
    })
    if (!checked.ok) return { kind: 'blocked', reason: checked.reason }
  }
  return null
}

async function publishAndRefreshSuccessor(
  authority: FeatureAuthority,
  own: Pick<MandateRecord['payload'], 'ownSpec' | 'tier' | 'children' | 'inheritedOwnSpecRefs' | 'coverage'>,
  target: FeatureCheckoutTarget,
  history: FeatureAuthority['history'],
  parentHistories: FeatureAuthority['parentHistories'],
  reader: UwReadPort,
): Promise<SelectionState | ContinueFeatureResult> {
  const { context, scope } = authority
  const succession = await publishSuccessorMandate({
    loaded: context.engine,
    history,
    scope,
    ...own,
    target,
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
  const causal = await composeObservedUwCausalContext(read, [nextHistory, ...parents.parents], options)
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
