import type { Scope } from '../engine/record-values.ts'
import { ticketOfBranch } from '../skills/feature/epic-claims.ts'
import type { FeatureAuthority } from './feature-continuation-admission.ts'
import type { ContinueFeatureResult } from './feature-contract.ts'
import { type FeatureCheckoutTarget, verifyParentCheckout } from './workflow-checkout.ts'

export async function initialCheckoutTarget(
  authority: FeatureAuthority,
  parent: Scope | null,
  projected: FeatureCheckoutTarget,
  branch: string,
): Promise<FeatureCheckoutTarget | ContinueFeatureResult> {
  const target: FeatureCheckoutTarget =
    projected.kind === 'branch' && authority.target.status === 'pull-request'
      ? { ...projected, attachExisting: true }
      : projected
  if (target.kind !== 'branch' || parent === null || authority.onPrincipal) return target
  const { context, scope } = authority
  const parentCheckout = await verifyParentCheckout({ git: context.git, cwd: context.cwd, uw: parent })
  if (!parentCheckout.ok) return { kind: 'blocked', reason: parentCheckout.reason }
  const current = await context.git(context.cwd, ['branch', '--show-current'])
  const number = Number(scope.target.slice(scope.target.lastIndexOf('#') + 1))
  if (
    current.code !== 0 ||
    ticketOfBranch(current.stdout.trim()) !== number ||
    (authority.target.status === 'pull-request' && current.stdout.trim() !== branch)
  )
    return { kind: 'blocked', reason: 'session-not-intended-worktree' }
  return { kind: 'branch', branch: current.stdout.trim() }
}
