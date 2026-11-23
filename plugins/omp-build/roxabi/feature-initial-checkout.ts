import type { FeatureAuthority } from './feature-continuation-admission.ts'
import type { ContinueFeatureResult } from './feature-contract.ts'
import { resolveBase } from './feature-mandate.ts'
import type { FeatureCheckoutTarget } from './workflow-checkout.ts'

export type InitialMandateCheckout = { branch: string; base: string; lineageHead: string }

export async function observeInitialCheckout(
  authority: FeatureAuthority,
  target: Extract<FeatureCheckoutTarget, { kind: 'branch' }>,
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
  const branch = await context.git(context.cwd, ['branch', '--show-current'])
  const head = await context.git(context.cwd, ['rev-parse', '--verify', 'HEAD'])
  if (branch.code !== 0 || head.code !== 0 || !/^[0-9a-f]{40}$/.test(head.stdout.trim())) {
    return { kind: 'blocked', reason: 'first-mandate-checkout-unreadable' }
  }
  if (branch.stdout.trim() !== target.branch) return { kind: 'blocked', reason: 'session-not-intended-worktree' }
  return {
    ok: true,
    principalHead,
    checkout: { branch: target.branch, base: expectedBase, lineageHead: head.stdout.trim() },
  }
}
