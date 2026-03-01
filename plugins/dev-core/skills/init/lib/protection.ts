/**
 * Apply branch protection rules to standard branches.
 */

import { PROTECTED_BRANCHES, BRANCH_PROTECTION_PAYLOAD } from '../../shared/config'
import { run } from '../../shared/github'

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
        { stdin: new TextEncoder().encode(payload), stdout: 'pipe', stderr: 'pipe' }
      )
      const code = await proc.exited
      results[branch] = code === 0
    } catch {
      results[branch] = false
    }
  }

  return results
}
