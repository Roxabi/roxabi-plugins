import { CLAMP_NEUTRAL, clampFix, LEDGER_BASE } from './sandbox-assertledger'
import { SEMCTX_BASE } from './sandbox-semctx-base'
import { fix, proven } from './sandbox-semctx-spec'
import type { Spec } from './sandbox-types'

/**
 * One fix PR both producers apply to: a VERIFIED change and a detection, posted
 * by one acquisition. assertledger checks worlds of one path set besides the
 * selected test, each an ancestor of the next, and the candidate adds a change
 * contract: its buggy world is the PR's first commit, `-buggy`, which opens and
 * proves the contract before the second fixes `clamp`.
 */
export const BOTH_CASE = { pr: 60, branch: 'fix/2-both', test: 'regression' } as const

export function bothSpec(overrides: Partial<Spec> = {}): Spec {
  const { pr, branch, test } = BOTH_CASE
  return {
    base: { ...SEMCTX_BASE, ...LEDGER_BASE },
    branches: [
      { name: `${branch}-buggy`, from: 'main', commits: [fix, proven] },
      { name: branch, from: `${branch}-buggy`, commits: [clampFix(test)] },
      { name: `${branch}-neutral`, from: branch, commits: [CLAMP_NEUTRAL] },
    ],
    issues: [{ number: 2, title: 'fix: clamp', issueType: 'fix' }],
    prs: [{ number: pr, branch, title: 'fix: clamp above range', body: 'Closes #2\n', closes: [2] }],
    ...overrides,
  }
}
