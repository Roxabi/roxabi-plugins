import type { FeatureAuthority } from './feature-continuation-admission.ts'
import type { ContinueFeatureResult } from './feature-contract.ts'
import { resolveBase } from './feature-mandate.ts'
import { linkedMove } from './feature-selection.ts'
import { type FeatureCheckoutTarget, prepareFeatureCheckout } from './workflow-checkout.ts'

export async function prepareRequestedSession(
  authority: FeatureAuthority,
  target: FeatureCheckoutTarget,
): Promise<ContinueFeatureResult | { ok: true; base: string }> {
  const { context, identity, scope } = authority
  const base = await resolveBase(context.git, identity.ok ? identity.principalTop : context.cwd)
  if ('reason' in base) return { kind: 'blocked', reason: base.reason }
  const prepared = await prepareFeatureCheckout({
    git: context.git,
    sessionCwd: context.cwd,
    target,
    base: base.base,
    repository: scope.repository,
  })
  if (prepared.status === 'blocked') return { kind: 'blocked', reason: prepared.reason }
  if (prepared.status === 'move') {
    const move = linkedMove(context.cwd, prepared.path)
    if (move) return move
  }
  if (prepared.status !== 'ready') return { kind: 'blocked', reason: 'session-not-intended-worktree' }
  return { ok: true, base: base.base }
}

export async function prepareSuccessorCheckout(
  authority: FeatureAuthority,
  target: FeatureCheckoutTarget,
): Promise<ContinueFeatureResult | null> {
  const { context, identity, scope } = authority
  const base = await resolveBase(context.git, identity.ok ? identity.principalTop : context.cwd)
  if ('reason' in base) return { kind: 'blocked', reason: base.reason }
  const prepared = await prepareFeatureCheckout({
    git: context.git,
    sessionCwd: context.cwd,
    target,
    base: base.base,
    repository: scope.repository,
  })
  if (prepared.status === 'blocked') return { kind: 'blocked', reason: prepared.reason }
  if (prepared.status === 'move') {
    const move = linkedMove(context.cwd, prepared.path)
    if (move) return move
  }
  return prepared.status === 'ready' ? null : { kind: 'blocked', reason: 'session-not-intended-worktree' }
}
