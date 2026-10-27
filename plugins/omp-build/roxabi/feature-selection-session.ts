import type { FeatureAuthority } from './feature-continuation-admission.ts'
import type { ContinueFeatureResult } from './feature-contract.ts'
import { resolveBase } from './feature-mandate.ts'
import { linkedMove } from './feature-selection.ts'
import { prepareFeatureCheckout, runWorktreeBootstrap } from './workflow-checkout.ts'

export async function prepareRequestedSession(
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
