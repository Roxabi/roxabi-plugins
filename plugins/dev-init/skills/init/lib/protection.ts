/**
 * Apply branch protection rules and rulesets to standard branches.
 */

import { run } from '../../shared/adapters/github-adapter'
import {
  buildBranchProtectionPayload,
  DEFAULT_RULESET,
  detectSecretScanWorkflow,
  PROTECTED_BRANCHES,
} from '../../shared/adapters/github-infra'

/** Per-branch outcome. `'skipped'` = the branch does not exist and was left alone. */
export type BranchOutcome = boolean | 'skipped'

export interface ProtectionResult {
  branches: Record<string, BranchOutcome>
  ruleset: boolean
}

export interface ProtectOptions {
  /**
   * Create and push a protected branch that does not exist yet. Off by default:
   * a missing branch is a deliberate repo state far more often than an oversight
   * (a trunk-mode repo has retired `staging` on purpose), and inventing it here
   * silently undoes that decision. Opt in when bootstrapping a fresh repo.
   */
  createMissing?: boolean
}

export async function protectBranches(repo: string, opts: ProtectOptions = {}): Promise<ProtectionResult> {
  const result: ProtectionResult = { branches: {}, ruleset: false }
  let hasSecretScan = false
  try {
    hasSecretScan = await detectSecretScanWorkflow(repo)
  } catch {
    // invalid repo or network error — proceed without secret-scan context
  }

  for (const branch of PROTECTED_BRANCHES) {
    try {
      // Ensure branch exists — but never invent one unless explicitly asked.
      // Mirrors the read side, which reports an absent branch as a skip rather
      // than a failure (checkup's doctor-github.ts).
      const branchExists = Bun.spawnSync(['git', 'rev-parse', '--verify', branch], { stdout: 'pipe', stderr: 'pipe' })
      if (branchExists.exitCode !== 0) {
        if (!opts.createMissing) {
          result.branches[branch] = 'skipped'
          continue
        }
        await run(['git', 'branch', branch])
        await run(['git', 'push', '-u', 'origin', branch])
      }

      // Apply protection via GitHub API (pipe JSON body to stdin)
      const payload = JSON.stringify(buildBranchProtectionPayload({ hasSecretScan }))
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
