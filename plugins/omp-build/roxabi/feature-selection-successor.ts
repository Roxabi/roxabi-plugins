import { canonicalValueDigest, projectNativeUwChildrenAgainstCommitments } from '../dist/contracts.js'
import type { NativeDeliveryPullRequest } from '../engine/uw-completion-types.ts'
import type { MandateRecord } from '../engine/workflow-control.ts'
import type { ParentCoverage } from '../engine/workflow-mandate-schema.ts'
import { causalRefusal } from './causal-refusal.ts'
import { checkoutTarget } from './feature-checkout-target.ts'
import { mandateParentHistories } from './feature-context.ts'
import type { FeatureAuthority } from './feature-continuation-admission.ts'
import type { ContinueFeatureResult, ParentCoverageRequest } from './feature-contract.ts'
import { freshSuccessorOwnSpec } from './feature-initial-own-spec.ts'
import { resolveSuccessorWorktreeAnchor } from './feature-parent-anchor.ts'
import { prepareSuccessorCheckout } from './feature-selection-session.ts'
import { publishSuccessorMandate, type SuccessionBasis } from './feature-succession.ts'
import {
  type ConfirmedSuccessor,
  confirmSuccessorHistories,
  currentSuccessionBasis,
  successorOwnDelivery,
} from './feature-succession-observation.ts'
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
  parentCoverage?: ParentCoverage | null
  parentCoverageBasis?: ParentCoverageRequest
}): Promise<SelectionState | ContinueFeatureResult> {
  const { authority, uwRead, reader, history, parentHistories } = input
  if (reader === undefined || uwRead === null) return { kind: 'blocked', reason: 'uw-read-required' }
  const observedBasis = await currentSuccessionBasis(authority, uwRead, history, parentHistories)
  if ('kind' in observedBasis) return observedBasis
  const basis = observedBasis.basis
  const delivery = await successorOwnDelivery(authority, observedBasis.histories, history)
  if ('kind' in delivery) return delivery
  const children = projectNativeUwChildrenAgainstCommitments({
    uw: authority.scope,
    graph: uwRead.graph,
    commitments: basis.historical.children,
  })
  const projected = checkoutTarget({
    uw: authority.scope,
    children,
    branch: basis.terminal.mandate.payload.branch ?? input.branch,
  })
  if ('kind' in projected) return projected
  const own = await freshSuccessorOwnSpec(
    authority.scope,
    uwRead,
    basis.historical,
    input.parentCoverage,
    input.parentCoverageBasis,
  )
  if ('kind' in own) return prepareSuccessorCoverageRequest(authority, uwRead, basis, projected.target, own)
  const anchor = await resolveSuccessorWorktreeAnchor({
    subject: authority.scope,
    read: uwRead,
    succession: { child: authority.scope, tip: basis.terminal.ref },
  })
  if (!anchor.ok) return { kind: 'blocked', reason: anchor.reason }
  if (projected.target.kind === 'parent') projected.target.uw = anchor.anchor
  const parentCheck = await ensureSuccessorParent(authority, uwRead, projected.target, anchor.anchor)
  if (parentCheck !== null) return parentCheck
  if (!successorPullBranchMatches(authority, projected.target))
    return { kind: 'blocked', reason: 'successor-branch-mismatch' }
  const target: FeatureCheckoutTarget =
    projected.target.kind === 'branch' && authority.target.status === 'pull-request'
      ? { ...projected.target, attachExisting: true }
      : projected.target
  const boot = await bootstrapSuccessor(authority, target)
  if ('kind' in boot) return boot
  const confirmed = await confirmSuccessorAfterBootstrap({
    pullRequests: delivery.pullRequests,
    authority,
    reader,
    own,
    basis,
    history,
    parentHistories,
    target,
    anchor: anchor.anchor,
    head: boot.head,
    branch: boot.branch,
    parentCoverage: input.parentCoverage,
    parentCoverageBasis: input.parentCoverageBasis,
  })
  if ('kind' in confirmed) return confirmed
  return publishAndRefreshSuccessor(
    authority,
    own,
    confirmed.basis,
    target,
    confirmed.history,
    confirmed.parents,
    reader,
    confirmed.delivery.pullRequests,
  )
}

function successorPullBranchMatches(authority: FeatureAuthority, target: FeatureCheckoutTarget): boolean {
  if (target.kind !== 'branch' || authority.target.status !== 'pull-request') return true
  return target.branch === authority.target.pullRequest.branch
}

async function prepareSuccessorCoverageRequest(
  authority: FeatureAuthority,
  read: UwRead,
  basis: SuccessionBasis,
  target: FeatureCheckoutTarget,
  outcome: ContinueFeatureResult,
): Promise<ContinueFeatureResult> {
  if (outcome.kind !== 'blocked' || outcome.coverageRequest === undefined || !authority.onPrincipal) return outcome
  const anchor = await resolveSuccessorWorktreeAnchor({
    subject: authority.scope,
    read,
    succession: { child: authority.scope, tip: basis.terminal.ref },
  })
  if (!anchor.ok) return { kind: 'blocked', reason: anchor.reason }
  if (target.kind === 'parent') target.uw = anchor.anchor
  return (await prepareSuccessorCheckout(authority, target)) ?? outcome
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
  basis: SuccessionBasis
  history: FeatureAuthority['history']
  parentHistories: FeatureAuthority['parentHistories']
  target: FeatureCheckoutTarget
  anchor: FeatureAuthority['scope']
  head: string
  branch: string
  pullRequests: readonly NativeDeliveryPullRequest[]
  parentCoverage?: ParentCoverage | null
  parentCoverageBasis?: ParentCoverageRequest
}): Promise<ConfirmedSuccessor | ContinueFeatureResult> {
  const { authority, reader, own, history, parentHistories } = input
  const latest = await reader.readUw(authority.scope)
  const observedBasis = await currentSuccessionBasis(authority, latest, history, parentHistories)
  if ('kind' in observedBasis) return observedBasis
  const currentBasis = observedBasis.basis
  if (canonicalValueDigest(currentBasis) !== canonicalValueDigest(input.basis))
    return { kind: 'blocked', reason: 'successor-antecedent-changed' }
  const children = projectNativeUwChildrenAgainstCommitments({
    uw: authority.scope,
    graph: latest.graph,
    commitments: currentBasis.historical.children,
  })
  if (!children.ok) return { kind: 'blocked', reason: 'uw-children-unconfirmed', diagnostics: children.diagnostics }
  if (children.value.length > 0 !== (input.target.kind === 'parent'))
    return { kind: 'blocked', reason: 'successor-framing-changed' }
  const current = await freshSuccessorOwnSpec(
    authority.scope,
    latest,
    currentBasis.historical,
    input.parentCoverage,
    input.parentCoverageBasis,
  )
  if ('kind' in current) return current
  if (canonicalValueDigest(current) !== canonicalValueDigest(own))
    return { kind: 'blocked', reason: 'successor-framing-changed' }
  const anchor = await resolveSuccessorWorktreeAnchor({
    subject: authority.scope,
    read: latest,
    succession: { child: authority.scope, tip: currentBasis.terminal.ref },
  })
  if (!anchor.ok) return { kind: 'blocked', reason: anchor.reason }
  if (canonicalValueDigest(anchor.anchor) !== canonicalValueDigest(input.anchor))
    return { kind: 'blocked', reason: 'successor-framing-changed' }
  const checkout = await confirmSuccessorCheckout(authority, input.target, input.head, input.branch)
  if (checkout !== null) return checkout
  const confirmed = await confirmSuccessorHistories(authority, latest, history, parentHistories, currentBasis)
  if ('kind' in confirmed) return confirmed
  if (canonicalValueDigest(input.pullRequests) !== canonicalValueDigest(confirmed.delivery.pullRequests))
    return { kind: 'blocked', reason: 'successor-binding-observation-changed' }
  return confirmed
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
  basis: SuccessionBasis,
  target: FeatureCheckoutTarget,
  history: FeatureAuthority['history'],
  parentHistories: FeatureAuthority['parentHistories'],
  reader: UwReadPort,
  observedPullRequests: readonly NativeDeliveryPullRequest[],
): Promise<SelectionState | ContinueFeatureResult> {
  const { context, scope } = authority
  const succession = await publishSuccessorMandate({
    loaded: context.engine,
    history,
    scope,
    basis,
    ...own,
    target,
    git: context.git,
    gh: context.gh,
    cwd: context.cwd,
    parents: parentHistories,
    observedPullRequests,
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
  if (!causal.ok) return { kind: 'blocked', ...causalRefusal(causal) }
  const selection = context.engine.selectApplicableMandate(nextHistory, parents.parents, causal.value)
  if (selection.status !== 'applicable') {
    return { kind: 'blocked', reason: `successor-${selection.status === 'refused' ? selection.reason : 'unconfirmed'}` }
  }
  return { history: nextHistory, parentHistories: parents.parents, causal: causal.value, selection }
}
