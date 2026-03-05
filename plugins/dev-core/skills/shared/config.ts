/**
 * @deprecated Use EnvConfigAdapter from adapters/env-config.ts instead.
 *
 * Shared configuration constants for GitHub Project V2 integration.
 * Single source of truth — used by both issues/ and issue-triage/ skills.
 *
 * Retained as a shim for existing callers during migration.
 * Re-exports pure logic from adapters/config-helpers.ts.
 */

// Re-export moved helpers from the adapter layer
export {
  DEFAULT_PRIORITY_OPTIONS,
  DEFAULT_SIZE_OPTIONS,
  DEFAULT_STATUS_OPTIONS,
  detectGitHubRepo,
  FIELD_MAP,
  fieldIdForSlot,
  GH_PROJECT_ID,
  isProjectConfigured,
  PRIORITY_ALIASES,
  PRIORITY_FIELD_ID,
  PRIORITY_OPTIONS,
  resolveFieldIds,
  resolvePriority,
  resolveSize,
  resolveStatus,
  SIZE_FIELD_ID,
  SIZE_OPTIONS,
  STATUS_ALIASES,
  STATUS_FIELD_ID,
  STATUS_OPTIONS,
} from './adapters/config-helpers'

import { detectGitHubRepo } from './adapters/config-helpers'

export const GITHUB_REPO = detectGitHubRepo()

export const NOT_CONFIGURED_MSG =
  'GitHub Project V2 is not configured. Run `/init` to auto-detect project board settings.'

export const PRIORITY_SHORT: Record<string, string> = {
  'P0 - Urgent': 'P0',
  'P1 - High': 'P1',
  'P2 - Medium': 'P2',
  'P3 - Low': 'P3',
}

export const STATUS_SHORT: Record<string, string> = {
  'In Progress': 'In Prog',
  Backlog: 'Backlog',
  Analysis: 'Analysis',
  Specs: 'Specs',
  Review: 'Review',
  Done: 'Done',
}

// --- Standard labels, workflows, branch protection ---

export interface LabelDef {
  name: string
  color: string
  description: string
  category: 'type' | 'area' | 'priority'
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
  { name: 'P0-critical', color: 'b60205', description: 'Critical priority', category: 'priority' },
  { name: 'P1-high', color: 'd93f0b', description: 'High priority', category: 'priority' },
  { name: 'P2-medium', color: 'fbca04', description: 'Medium priority', category: 'priority' },
  { name: 'P3-low', color: '0e8a16', description: 'Low priority', category: 'priority' },
]

export const STANDARD_WORKFLOWS = ['ci.yml', 'auto-merge.yml', 'pr-title.yml', 'deploy-preview.yml'] as const
/** Secrets required by standard workflows. auto-merge.yml needs PAT. */
export const REQUIRED_SECRETS: Record<string, string> = {
  'auto-merge.yml': 'PAT',
}
export const PROTECTED_BRANCHES = ['main', 'staging'] as const
export const BRANCH_PROTECTION_PAYLOAD = {
  required_pull_request_reviews: { required_approving_review_count: 1 },
  required_status_checks: { strict: true, contexts: ['ci'] },
  enforce_admins: false,
  restrictions: null,
}

// Sort orders
export const PRIORITY_ORDER: Record<string, number> = {
  'P0 - Urgent': 0,
  'P1 - High': 1,
  'P2 - Medium': 2,
  'P3 - Low': 3,
  '-': 99,
}

export const SIZE_ORDER: Record<string, number> = {
  XL: 0,
  L: 1,
  M: 2,
  S: 3,
  XS: 4,
  '-': 99,
}

export const STATUS_ORDER: Record<string, number> = {
  Review: 0,
  'In Progress': 1,
  Specs: 2,
  Analysis: 3,
  Backlog: 4,
  '-': 99,
}

export const BLOCK_ORDER: Record<string, number> = {
  blocking: 0,
  ready: 1,
  blocked: 2,
}
