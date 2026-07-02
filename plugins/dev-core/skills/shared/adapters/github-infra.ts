/**
 * GitHub infrastructure constants — workflows, secrets, branch protection
 * rules, and rulesets used by /init and /checkup (repo hardening).
 */

import { ConfigError } from '../domain/errors'

export const STANDARD_WORKFLOWS = [
  'ci.yml',
  'auto-merge.yml',
  'pr-title.yml',
  'context-lint.yml',
  'deploy-preview.yml',
] as const

/**
 * Token mode for CI workflows.
 *   github-app — ephemeral installation token via roxabi-ci App (default for org repos).
 *   pat         — legacy PAT (fallback for solo/non-org repos); emits a retirement banner.
 */
export type TokenMode = 'github-app' | 'pat'

/**
 * SHA-pinned mint step for the roxabi-ci GitHub App.
 * Consumers reference `${{ steps.app.outputs.token }}`.
 * NEVER use a floating tag — pin is bcd2ba49218906704ab6c1aa796996da409d3eb1 (v3.2.0).
 */
export const APP_MINT_STEP = `      # roxabi-ci App token (ephemeral, 1 h) — pushes re-trigger CI,
      # which GITHUB_TOKEN cannot do.
      - name: Mint app token (roxabi-ci)
        id: app
        uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1  # v3.2.0
        with:
          app-id: \${{ vars.ROXABI_CI_APP_ID }}
          private-key: \${{ secrets.ROXABI_CI_APP_PRIVATE_KEY }}`

/** Emit the App mint step as a YAML snippet (indented for a `steps:` block). */
export function emitAppMintStep(): string {
  return APP_MINT_STEP
}

/**
 * Secrets/variables required by standard workflows.
 *   github-app mode: ROXABI_CI_APP_ID (var) + ROXABI_CI_APP_PRIVATE_KEY (secret)
 *   pat mode:        PAT (secret, legacy)
 */
export const REQUIRED_SECRETS: Record<string, { mode: TokenMode; var?: string; secret: string }> = {
  'auto-merge.yml': { mode: 'github-app', var: 'ROXABI_CI_APP_ID', secret: 'ROXABI_CI_APP_PRIVATE_KEY' },
  'release-please.yml': { mode: 'github-app', var: 'ROXABI_CI_APP_ID', secret: 'ROXABI_CI_APP_PRIVATE_KEY' },
}

/** PAT retirement banner — shown when mode: pat is selected. */
export const PAT_RETIREMENT_BANNER =
  '# ⚠️  PAT mode: secrets.PAT is retiring org-wide. App mode is preferred for Roxabi-org repos.'

export const PROTECTED_BRANCHES = ['main', 'staging'] as const

export interface BranchProtectionOpts {
  hasSecretScan: boolean
}

const REPO_FORMAT = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/

function assertValidRepo(repo: string): void {
  if (!REPO_FORMAT.test(repo)) throw new ConfigError(`Invalid repo format: ${repo}`)
}

export function buildBranchProtectionPayload(opts: BranchProtectionOpts) {
  const contexts = ['ci']
  if (opts.hasSecretScan) contexts.push('trufflehog')
  return {
    required_status_checks: { strict: true, contexts },
    enforce_admins: false,
    restrictions: null,
  }
}

export async function detectSecretScanWorkflow(repo: string): Promise<boolean> {
  assertValidRepo(repo)
  try {
    const proc = Bun.spawnSync(['gh', 'api', `repos/${repo}/contents/.github/workflows/secret-scan.yml`], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    return proc.exitCode === 0
  } catch {
    return false
  }
}

export const DEFAULT_RULESET = {
  name: 'PR_Main',
  target: 'branch',
  enforcement: 'active',
  conditions: {
    ref_name: {
      include: ['refs/heads/main'],
      exclude: [],
    },
  },
  rules: [
    { type: 'deletion' },
    { type: 'non_fast_forward' },
    {
      type: 'pull_request',
      parameters: {
        required_approving_review_count: 0,
        dismiss_stale_reviews_on_push: true,
        required_reviewers: [],
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_review_thread_resolution: true,
        allowed_merge_methods: ['merge'], // merge-commit only — project convention (Release Convention)
      },
    },
  ],
  bypass_actors: [
    {
      actor_id: 5,
      actor_type: 'RepositoryRole',
      bypass_mode: 'always',
    },
  ],
} as const
