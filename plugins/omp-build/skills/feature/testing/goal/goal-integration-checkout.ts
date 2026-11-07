import { canonicalValueDigest } from '../../../../engine/action-input.ts'
import type { DeclaredCheckout } from '../../../../testing/native-implementation-world.ts'
import { git } from './goal-scenario-sandbox.ts'

export function verifyGoalCheckout(cwd: string, current: DeclaredCheckout, facts: DeclaredCheckout): void {
  if (
    canonicalValueDigest(facts) !== canonicalValueDigest(current) ||
    git(cwd, ['rev-parse', 'HEAD']) !== facts.head ||
    git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']) !== (facts.branch === null ? 'HEAD' : facts.branch) ||
    git(cwd, ['rev-parse', `refs/remotes/origin/${facts.base}`]) !== facts.baseTip ||
    git(cwd, ['ls-remote', 'origin', `refs/heads/${facts.branch === null ? facts.base : facts.branch}`]).split(
      /\s+/,
    )[0] !== facts.remoteTip
  )
    throw new Error('Goal parent Git checkout no longer matches its declared facts')
}
