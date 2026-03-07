/**
 * Apply branch protection rules to standard branches.
 */

import { BRANCH_PROTECTION_PAYLOAD, PROTECTED_BRANCHES } from '../../shared/adapters/config-helpers'
import { run } from '../../shared/adapters/github-adapter'

export async function protectBranches(repo: string): Promise<Record<string, boolean>> {
  const results: Record<string, boolean> = {}

  for (const branch of PROTECTED_BRANCHES) {
    try {
      // Ensure branch exists
      const branchExists = Bun.spawnSync(['git', 'rev-parse', '--verify', branch], { stdout: 'pipe', stderr: 'pipe' })
      if (branchExists.exitCode !== 0) {
        await run(['git', 'branch', branch])
        await run(['git', 'push', '-u', 'origin', branch])
      }

      // Apply protection via GitHub API (pipe JSON body to stdin)
      const payload = JSON.stringify(BRANCH_PROTECTION_PAYLOAD)
      const proc = Bun.spawn(
        ['gh', 'api', `repos/${repo}/branches/${branch}/protection`, '-X', 'PUT', '--input', '-'],
        { stdin: new TextEncoder().encode(payload), stdout: 'pipe', stderr: 'pipe' },
      )
      const code = await proc.exited

      // Remove PR review requirement — the "reviewed" label is the merge gate,
      // not GitHub's native review approval (which blocks self-authored PRs).
      if (code === 0) {
        const delProc = Bun.spawn(
          ['gh', 'api', `repos/${repo}/branches/${branch}/protection/required_pull_request_reviews`, '-X', 'DELETE'],
          { stdout: 'pipe', stderr: 'pipe' },
        )
        await delProc.exited // 204 = removed, 404 = already absent — both OK
      }

      results[branch] = code === 0
    } catch {
      results[branch] = false
    }
  }

  return results
}
