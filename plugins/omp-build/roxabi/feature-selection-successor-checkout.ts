import type { FeatureAuthority } from './feature-continuation-admission.ts'
import type { ContinueFeatureResult } from './feature-contract.ts'
import { resolveSuccessorWorktreeAnchor } from './feature-parent-anchor.ts'
import { prepareSuccessorCheckout } from './feature-selection-session.ts'
import type { SuccessionBasis } from './feature-succession.ts'
import type { UwRead } from './uw-contract.ts'
import type { FeatureCheckoutTarget } from './workflow-checkout.ts'
import { runWorktreeBootstrap, verifyParentCheckout } from './workflow-checkout.ts'

export async function prepareSuccessorCoverageRequest(
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

export async function bootstrapSuccessor(
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

export async function ensureSuccessorParent(
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

export async function confirmSuccessorCheckout(
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
