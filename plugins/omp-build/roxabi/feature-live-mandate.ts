import type { Gh } from '../adapters/github/types.ts'
import { githubScope, outstandingPauseInAuthority, resolveSpecEffective } from '../dist/contracts.js'
import type { Scope } from '../engine/record-values.ts'
import type { OwnSpecRef } from '../engine/uw-spec-schema.ts'
import { type FeatureAuthority, resolveFeatureAuthority } from './feature-continuation-admission.ts'
import { featureLeafStatus } from './feature-leaf-status.ts'
import { featureSpecDigest } from './feature-spec-digest.ts'
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
  expectedSpecDigest?: string,
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
  const acceptedOwn = requireCurrentLeaf(result)
  const { base, branch, role, ownSpec } = result.selection.mandate.payload
  if (
    role !== 'feature' ||
    branch === null ||
    branch === base ||
    ownSpec.uw.repository !== scope.repository ||
    ownSpec.uw.target !== scope.target
  )
    throw new Error('feature-leaf-mandate-required')
  if (worktreeRequired) await requireFeatureWorktree(input, result.identity, branch)
  if (expectedSpecDigest !== undefined) requireCurrentSpecDigest(result, acceptedOwn, expectedSpecDigest)
  return { scope, ref, base, branch }
}

async function requireFeatureWorktree(
  { cwd, git }: { cwd: string; git: GitRunner },
  identity: FeatureAuthority['identity'],
  branch: string,
): Promise<void> {
  if (!identity.ok || identity.onPrincipal) throw new Error('feature-worktree-required')
  const current = await git(cwd, ['symbolic-ref', '--quiet', 'HEAD'])
  if (current.code !== 0 || current.stdout.trim() !== `refs/heads/${branch}`) throw new Error('feature-branch-mismatch')
}

function requireCurrentLeaf(authority: FeatureAuthority): OwnSpecRef {
  const { context, history, parentHistories, causal } = authority
  const current = context.engine.resolveOwnSpecAuthority(history, parentHistories, causal)
  const acceptedChildCount = current.ok ? current.value.accepted.children.length : null
  const status = featureLeafStatus(authority, causal.observation.graph, acceptedChildCount)
  if (status !== 'leaf' || !current.ok)
    throw new Error(status === 'parent' ? 'parent-delivery-suspended' : 'leaf-status-unknown')
  return current.value.accepted.ref
}

function requireCurrentSpecDigest(authority: FeatureAuthority, own: OwnSpecRef, expected: string): void {
  const { histories, observation } = authority.causal
  const effective = resolveSpecEffective({ mode: 'current', own, histories, graph: observation.graph })
  if (!effective.ok || featureSpecDigest(effective.value) !== expected) throw new Error('spec-changed')
}
