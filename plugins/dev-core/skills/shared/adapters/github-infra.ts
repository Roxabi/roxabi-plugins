/**
 * GitHub infrastructure constants — standard labels, workflows, secrets,
 * branch protection rules, and rulesets used by /init and /checkup.
 *
 * Dependency direction: github-infra → github-adapter (clean, no cycle).
 */

import {
  LANE_LABEL_MAP,
  LANE_LABELS_SET,
  PRIORITY_LABEL_MAP,
  PRIORITY_LABELS_SET,
  SIZE_LABEL_MAP,
  SIZE_LABELS_SET,
} from './config-helpers'

export interface LabelDef {
  name: string
  color: string
  description: string
  category: 'type' | 'area'
}

export const STANDARD_LABELS: LabelDef[] = [
  { name: 'bug', color: 'd73a4a', description: "Something isn't working", category: 'type' },
  { name: 'feature', color: '0075ca', description: 'New functionality', category: 'type' },
  { name: 'enhancement', color: 'a2eeef', description: 'Improve existing functionality', category: 'type' },
  { name: 'docs', color: '5319e7', description: 'Documentation only', category: 'type' },
  { name: 'chore', color: 'ededed', description: 'Maintenance, deps, config', category: 'type' },
  { name: 'research', color: 'd4c5f9', description: 'Investigation or spike', category: 'type' },
  { name: 'frontend', color: '1d76db', description: 'Frontend', category: 'area' },
  { name: 'backend', color: 'e99695', description: 'Backend', category: 'area' },
  { name: 'infra', color: 'f9d0c4', description: 'Infrastructure', category: 'area' },
  { name: 'api', color: 'bfd4f2', description: 'API', category: 'area' },
  { name: 'design', color: 'c5def5', description: 'Design', category: 'area' },
]

export const STANDARD_WORKFLOWS = ['ci.yml', 'auto-merge.yml', 'pr-title.yml', 'deploy-preview.yml'] as const

/** Secrets required by standard workflows. auto-merge.yml needs PAT. */
export const REQUIRED_SECRETS: Record<string, string> = {
  'auto-merge.yml': 'PAT',
}

export const PROTECTED_BRANCHES = ['main', 'staging'] as const

export const BRANCH_PROTECTION_PAYLOAD = {
  required_status_checks: { strict: true, contexts: ['ci'] },
  enforce_admins: false,
  restrictions: null,
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
        allowed_merge_methods: ['squash', 'rebase', 'merge'],
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

/**
 * Sync priority label on a GitHub issue. Adds the target label and removes stale ones.
 * Non-fatal: logs a warning on failure but does not throw.
 */
export async function syncPriorityLabel(issueNumber: number, canonical: string): Promise<void> {
  const target = PRIORITY_LABEL_MAP[canonical]
  if (!target) return

  const stale = [...PRIORITY_LABELS_SET].filter((l) => l !== target)

  try {
    const { updateLabels } = await import('./github-adapter')
    await updateLabels(issueNumber, [target], stale)
  } catch (err) {
    console.error(`Warning: Failed to sync priority label for #${issueNumber}: ${err}`)
  }
}

/**
 * Sync size label on a GitHub issue. Adds the target label and removes stale ones.
 * Non-fatal: logs a warning on failure but does not throw.
 */
export async function syncSizeLabel(issueNumber: number, canonical: string): Promise<void> {
  const target = SIZE_LABEL_MAP[canonical]
  if (!target) return

  const stale = [...SIZE_LABELS_SET].filter((l) => l !== target)

  try {
    const { updateLabels } = await import('./github-adapter')
    await updateLabels(issueNumber, [target], stale)
  } catch (err) {
    console.error(`Warning: Failed to sync size label for #${issueNumber}: ${err}`)
  }
}

/**
 * Sync lane label on a GitHub issue. Adds the target label and removes stale ones.
 * Non-fatal: logs a warning on failure but does not throw.
 */
export async function syncLaneLabel(issueNumber: number, canonical: string): Promise<void> {
  const target = LANE_LABEL_MAP[canonical]
  if (!target) return

  const stale = [...LANE_LABELS_SET].filter((l) => l !== target)

  try {
    const { updateLabels } = await import('./github-adapter')
    await updateLabels(issueNumber, [target], stale)
  } catch (err) {
    console.error(`Warning: Failed to sync lane label for #${issueNumber}: ${err}`)
  }
}
