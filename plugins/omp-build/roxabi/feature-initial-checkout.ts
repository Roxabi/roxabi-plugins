import type { FeatureAuthority } from './feature-continuation-admission.ts'
import type { ContinueFeatureResult } from './feature-contract.ts'
import { resolveBase } from './feature-mandate.ts'
import { type FeatureCheckoutTarget, verifyParentCheckout } from './workflow-checkout.ts'

export type InitialMandateCheckout =
  | { kind: 'parent'; branch: null; base: string; lineageHead: string }
  | { kind: 'leaf'; branch: string; base: string; lineageHead: string }

export async function observeInitialCheckout(
  authority: FeatureAuthority,
  target: FeatureCheckoutTarget,
  expectedBase: string,
): Promise<{ ok: true; checkout: InitialMandateCheckout; principalHead: string } | ContinueFeatureResult> {
  const { context, identity } = authority
  if (!identity.ok || identity.onPrincipal) return { kind: 'blocked', reason: 'session-not-intended-worktree' }
  const base = await resolveBase(context.git, identity.principalTop)
  if ('reason' in base) return { kind: 'blocked', reason: base.reason }
  if (base.base !== expectedBase) return { kind: 'blocked', reason: 'first-mandate-base-changed' }
  const principal = await context.git(identity.principalTop, ['rev-parse', '--verify', 'HEAD'])
  if (principal.code !== 0 || !/^[0-9a-f]{40}$/.test(principal.stdout.trim()))
    return { kind: 'blocked', reason: 'principal-head-unreadable' }
  const principalHead = principal.stdout.trim()
  if (target.kind === 'parent') {
    const checked = await verifyParentCheckout({ git: context.git, cwd: context.cwd, uw: target.uw })
    if (!checked.ok) return { kind: 'blocked', reason: checked.reason }
  }
  const branch = await context.git(context.cwd, ['branch', '--show-current'])
  const head = await context.git(context.cwd, ['rev-parse', '--verify', 'HEAD'])
  if (branch.code !== 0 || head.code !== 0 || !/^[0-9a-f]{40}$/.test(head.stdout.trim())) {
    return { kind: 'blocked', reason: 'first-mandate-checkout-unreadable' }
  }
  const lineageHead = head.stdout.trim()
  if (target.kind === 'branch')
    return observeLeafCheckout(target, branch.stdout, expectedBase, lineageHead, principalHead)
  if (branch.stdout.trim() !== '') return { kind: 'blocked', reason: 'parent-checkout-not-detached' }
  const current = await verifyInitialParentBase(authority, identity.principalTop, expectedBase, lineageHead)
  if (current !== null) return current
  return { ok: true, principalHead, checkout: { kind: 'parent', branch: null, base: expectedBase, lineageHead } }
}

function observeLeafCheckout(
  target: Extract<FeatureCheckoutTarget, { kind: 'branch' }>,
  branch: string,
  base: string,
  lineageHead: string,
  principalHead: string,
): { ok: true; checkout: InitialMandateCheckout; principalHead: string } | ContinueFeatureResult {
  if (branch.trim() !== target.branch) return { kind: 'blocked', reason: 'session-not-intended-worktree' }
  return { ok: true, principalHead, checkout: { kind: 'leaf', branch: target.branch, base, lineageHead } }
}

async function verifyInitialParentBase(
  authority: FeatureAuthority,
  principalTop: string,
  expectedBase: string,
  lineageHead: string,
): Promise<ContinueFeatureResult | null> {
  const { context } = authority
  const fetched = await context.git(principalTop, [
    'fetch',
    'origin',
    `+refs/heads/${expectedBase}:refs/remotes/origin/${expectedBase}`,
  ])
  if (fetched.code !== 0) return { kind: 'blocked', reason: 'base-not-current' }
  const tip = await context.git(principalTop, ['rev-parse', '--verify', `refs/remotes/origin/${expectedBase}`])
  if (tip.code !== 0 || tip.stdout.trim() !== lineageHead) return { kind: 'blocked', reason: 'base-not-current' }
  return null
}
