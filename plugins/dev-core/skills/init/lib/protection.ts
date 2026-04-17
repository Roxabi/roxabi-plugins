/**
 * Apply branch protection rules and rulesets to standard branches.
 */

import { run } from '../../shared/adapters/github-adapter'
import { BRANCH_PROTECTION_PAYLOAD, DEFAULT_RULESET, PROTECTED_BRANCHES } from '../../shared/adapters/github-infra'

export interface ProtectionResult {
  branches: Record<string, boolean>
  ruleset: boolean
}

export async function protectBranches(repo: string): Promise<ProtectionResult> {
  const result: ProtectionResult = { branches: {}, ruleset: false }

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

      result.branches[branch] = code === 0
    } catch {
      result.branches[branch] = false
    }
  }

  // Create or update PR_Main ruleset (idempotent)
  result.ruleset = await ensureRuleset(repo)

  return result
}

/**
 * Ensure the PR_Main ruleset exists. If it already exists, skip.
 * Returns true on success or if already present.
 */
async function ensureRuleset(repo: string): Promise<boolean> {
  try {
    // Check existing rulesets
    const listResult = Bun.spawnSync(['gh', 'api', `repos/${repo}/rulesets`, '--jq', '.[].name'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (listResult.exitCode === 0) {
      const names = new TextDecoder().decode(listResult.stdout).trim()
      if (names.split('\n').includes(DEFAULT_RULESET.name)) {
        return true // already exists
      }
    }

    // Create ruleset
    const payload = JSON.stringify(DEFAULT_RULESET)
    const createProc = Bun.spawn(['gh', 'api', `repos/${repo}/rulesets`, '--method', 'POST', '--input', '-'], {
      stdin: new TextEncoder().encode(payload),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    return (await createProc.exited) === 0
  } catch {
    return false
  }
}
