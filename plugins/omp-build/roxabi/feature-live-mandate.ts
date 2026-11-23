import type { Gh } from '../adapters/github/types.ts'
import { githubScope, outstandingPauseInAuthority } from '../dist/contracts.js'
import type { Scope } from '../engine/record-values.ts'
import { resolveFeatureAuthority } from './feature-continuation-admission.ts'
import type { GitRunner } from './workflow-checkout.ts'

export type FeatureCoordinates = { repository: string; issue: number; mandate: string }
export type LiveFeatureMandate = {
  scope: Scope
  ref: { kind: 'mandate'; scope: Scope; recordId: string }
  base: string
  branch: string
}

/** Exact issue and mandate only. No operator control, checkout preparation, or record writes. */
export async function readLiveFeatureMandate(
  input: FeatureCoordinates & { cwd: string; gh: Gh; git: GitRunner },
  worktreeRequired: boolean,
): Promise<LiveFeatureMandate> {
  const scope = githubScope(input.repository, input.issue)
  const ref = { kind: 'mandate' as const, scope, recordId: input.mandate }
  const result = await resolveFeatureAuthority(
    { ...input, reference: scope.target, control: 'continue', principal: false },
    ref,
  )
  if ('kind' in result) throw new Error('reason' in result ? result.reason : 'exact-mandate-not-applicable')
  if (result.target.status !== 'issue' || result.selection.status !== 'applicable')
    throw new Error('exact-mandate-not-applicable')
  if (outstandingPauseInAuthority(result.selection.mandate, [result.history, ...result.parentHistories]) !== null)
    throw new Error('exact-mandate-pause-unconfirmed')
  const { base, branch, role, children, ownSpec } = result.selection.mandate.payload
  if (
    role !== 'feature' ||
    branch === null ||
    branch === base ||
    children.length !== 0 ||
    ownSpec.uw.repository !== scope.repository ||
    ownSpec.uw.target !== scope.target
  )
    throw new Error('feature-leaf-mandate-required')
  if (worktreeRequired) {
    if (!result.identity.ok || result.identity.onPrincipal) throw new Error('feature-worktree-required')
    const current = await input.git(input.cwd, ['symbolic-ref', '--quiet', 'HEAD'])
    if (current.code !== 0 || current.stdout.trim() !== `refs/heads/${branch}`)
      throw new Error('feature-branch-mismatch')
  }
  return { scope, ref, base, branch }
}
