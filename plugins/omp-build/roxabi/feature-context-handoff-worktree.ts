import { realpathSync } from 'node:fs'
import type { FeatureAuthority } from './feature-continuation-admission.ts'
import { sessionWorktreeIdentity } from './workflow-checkout.ts'
import { checkoutPath } from './workflow-checkout-path.ts'

export async function canonicalContextWorktree(authority: FeatureAuthority, branch: string): Promise<boolean> {
  const { context, scope } = authority
  const identity = await sessionWorktreeIdentity(context.git, context.cwd)
  if (!identity.ok || identity.onPrincipal) return false
  const expected = await checkoutPath(context.git, identity.principalTop, scope.repository, branch)
  if (typeof expected !== 'string') return false
  try {
    return realpathSync(identity.sessionTop) === realpathSync(expected)
  } catch {
    return false
  }
}

export async function canonicalPredecessorWorktree(
  authority: FeatureAuthority,
  branch: string,
): Promise<string | null> {
  const { context, scope } = authority
  const identity = await sessionWorktreeIdentity(context.git, context.cwd)
  if (!identity.ok || identity.onPrincipal) return null
  const path = await checkoutPath(context.git, identity.principalTop, scope.repository, branch)
  if (typeof path !== 'string') return null
  const listed = await context.git(identity.sessionTop, ['worktree', 'list', '--porcelain'])
  if (listed.code !== 0) return null
  try {
    const expected = realpathSync(path)
    const matches = listed.stdout.split('\n').filter((line) => {
      if (!line.startsWith('worktree ')) return false
      try {
        return realpathSync(line.slice('worktree '.length)) === expected
      } catch {
        return false
      }
    })
    return matches.length === 1 ? expected : null
  } catch {
    return null
  }
}
