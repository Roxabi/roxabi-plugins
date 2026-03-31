/**
 * Pure config helper functions extracted from the legacy config.ts shim.
 * These are used by EnvConfigAdapter and re-exported from config.ts for backward compat.
 */

import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import type { ProjectFieldIds } from '../domain/types'
import type { WorkspaceProject } from '../ports/workspace'

/**
 * Load a config value from .claude/dev-core.yml with 3-tier fallback:
 *   1st: .claude/dev-core.yml (YAML key lookup)
 *   2nd: process.env[envKey]
 *   3rd: gh repo view (github_repo key only)
 */
function loadDevCoreConfig(key: string, envKey?: string): string | undefined {
  // 1st: Try .claude/dev-core.yml
  try {
    const yaml = readFileSync('.claude/dev-core.yml', 'utf-8')
    const match = yaml.match(new RegExp(`^${key}:\\s*['"]?(.+?)['"]?\\s*$`, 'm'))
    const value = match?.[1]
    if (value && value !== "''") return value
  } catch {
    /* file not found — fall through */
  }

  // 2nd: Fall back to env var
  const envValue = process.env[envKey ?? key.toUpperCase()]
  if (envValue) return envValue

  // 3rd: For github_repo only, try gh CLI
  if (key === 'github_repo') {
    try {
      return execSync('gh repo view --json nameWithOwner --jq .nameWithOwner', { encoding: 'utf-8' }).trim()
    } catch {
      /* gh not available */
    }
  }

  return undefined
}

export function detectGitHubRepo(): string {
  const fromYamlOrEnv = loadDevCoreConfig('github_repo', 'GITHUB_REPO')
  if (fromYamlOrEnv) return fromYamlOrEnv
  try {
    const proc = Bun.spawnSync(['git', 'remote', 'get-url', 'origin'], { stdout: 'pipe', stderr: 'pipe' })
    const url = new TextDecoder().decode(proc.stdout).trim()
    // SSH: git@github.com:owner/repo.git  |  HTTPS: https://github.com/owner/repo.git
    const match = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/)
    if (match?.[1]) return match[1]
  } catch {}
  throw new Error('Cannot detect GitHub repo. Set GITHUB_REPO env var or ensure git remote "origin" is configured.')
}

export const GH_PROJECT_ID = loadDevCoreConfig('gh_project_id', 'GH_PROJECT_ID') ?? ''
export const STATUS_FIELD_ID = loadDevCoreConfig('status_field_id', 'STATUS_FIELD_ID') ?? ''
export const SIZE_FIELD_ID = loadDevCoreConfig('size_field_id', 'SIZE_FIELD_ID') ?? ''
export const PRIORITY_FIELD_ID = loadDevCoreConfig('priority_field_id', 'PRIORITY_FIELD_ID') ?? ''

/** Parse a JSON string into a Record, falling back to the provided default. */
function parseOptionsValue(raw: string | undefined, fallback: Record<string, string>): Record<string, string> {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as Record<string, string>
  } catch {
    return fallback
  }
}

export const STATUS_OPTIONS: Record<string, string> = parseOptionsValue(
  loadDevCoreConfig('status_options_json', 'STATUS_OPTIONS_JSON'),
  {},
)
export const SIZE_OPTIONS: Record<string, string> = parseOptionsValue(
  loadDevCoreConfig('size_options_json', 'SIZE_OPTIONS_JSON'),
  {},
)
export const PRIORITY_OPTIONS: Record<string, string> = parseOptionsValue(
  loadDevCoreConfig('priority_options_json', 'PRIORITY_OPTIONS_JSON'),
  {},
)

/** True when GH_PROJECT_ID and at least one option map are configured via env or YAML. */
export function isProjectConfigured(): boolean {
  return GH_PROJECT_ID !== '' && Object.keys(STATUS_OPTIONS).length > 0
}

export const FIELD_MAP: Record<string, { fieldId: string; options: Record<string, string> }> = {
  status: { fieldId: STATUS_FIELD_ID, options: STATUS_OPTIONS },
  size: { fieldId: SIZE_FIELD_ID, options: SIZE_OPTIONS },
  priority: { fieldId: PRIORITY_FIELD_ID, options: PRIORITY_OPTIONS },
}

// CLI aliases — map loose user input to canonical option keys
export const STATUS_ALIASES: Record<string, string> = {
  BACKLOG: 'Backlog',
  ANALYSIS: 'Analysis',
  SPECS: 'Specs',
  'IN PROGRESS': 'In Progress',
  IN_PROGRESS: 'In Progress',
  INPROGRESS: 'In Progress',
  REVIEW: 'Review',
  DONE: 'Done',
}

export const PRIORITY_ALIASES: Record<string, string> = {
  URGENT: 'P0 - Urgent',
  HIGH: 'P1 - High',
  MEDIUM: 'P2 - Medium',
  LOW: 'P3 - Low',
  P0: 'P0 - Urgent',
  P1: 'P1 - High',
  P2: 'P2 - Medium',
  P3: 'P3 - Low',
}

// Canonical field option arrays — single source of truth for field creation and validation
export const DEFAULT_STATUS_OPTIONS = ['Backlog', 'Analysis', 'Specs', 'In Progress', 'Review', 'Done']
export const DEFAULT_SIZE_OPTIONS = ['XS', 'S', 'M', 'L', 'XL']
export const DEFAULT_PRIORITY_OPTIONS = ['P0 - Urgent', 'P1 - High', 'P2 - Medium', 'P3 - Low']

const CANONICAL_STATUSES = new Set(DEFAULT_STATUS_OPTIONS)
const CANONICAL_SIZES = new Set(DEFAULT_SIZE_OPTIONS)
const CANONICAL_PRIORITIES = new Set(DEFAULT_PRIORITY_OPTIONS)

/** Resolve loose user input to a canonical status key, or undefined. */
export function resolveStatus(input: string): string | undefined {
  if (CANONICAL_STATUSES.has(input)) return input
  return STATUS_ALIASES[input.toUpperCase()]
}

/** Resolve loose user input to a canonical priority key, or undefined. */
export function resolvePriority(input: string): string | undefined {
  if (CANONICAL_PRIORITIES.has(input)) return input
  return PRIORITY_ALIASES[input.toUpperCase()]
}

/** Resolve loose user input to a canonical size key, or undefined. */
export function resolveSize(input: string): string | undefined {
  const upper = input.toUpperCase()
  if (CANONICAL_SIZES.has(upper)) return upper
  return
}

/**
 * Resolve field IDs for a project.
 * Uses project.fieldIds when present (per-project); falls back to .env for legacy single-project mode.
 * Throws when fieldIds is explicitly provided but status is missing.
 */
export function resolveFieldIds(project: WorkspaceProject): ProjectFieldIds {
  if (project.fieldIds && Object.keys(project.fieldIds).length > 0) {
    if (!project.fieldIds.status) {
      throw new Error(`[project ${project.label}] fieldIds.status is required`)
    }
    return project.fieldIds
  }
  // Fallback: build from .env (existing behavior)
  // Empty fieldIds ({}) also falls through here — written by /init when field resolution fails.
  console.warn(
    `[dev-core] project "${project.label}" has no fieldIds — falling back to .env field IDs. Run /init to persist per-project field IDs.`,
  )
  return {
    status: STATUS_FIELD_ID,
    col2: SIZE_FIELD_ID,
    col3: PRIORITY_FIELD_ID,
    statusOptions: STATUS_OPTIONS,
    col2Options: SIZE_OPTIONS,
    col3Options: PRIORITY_OPTIONS,
  }
}

/** Return the field ID for a given slot (col2 or col3), or undefined when absent. */
export function fieldIdForSlot(project: WorkspaceProject, slot: 'col2' | 'col3'): string | undefined {
  return resolveFieldIds(project)[slot]
}

// --- Exports consolidated from legacy config.ts shim ---

export const GITHUB_REPO = detectGitHubRepo()

export const NOT_CONFIGURED_MSG =
  'GitHub Project V2 is not configured. Run `/init` to auto-detect project board settings.'

export const PRIORITY_SHORT: Record<string, string> = {
  'P0 - Urgent': 'P0',
  'P1 - High': 'P1',
  'P2 - Medium': 'P2',
  'P3 - Low': 'P3',
}

/** Map canonical project priority → GitHub label name. */
export const PRIORITY_LABEL_MAP: Record<string, string> = {
  'P0 - Urgent': 'P0-critical',
  'P1 - High': 'P1-high',
  'P2 - Medium': 'P2-medium',
  'P3 - Low': 'P3-low',
}

/** Set of all priority label names (for stale label removal). */
export const PRIORITY_LABELS_SET = new Set(Object.values(PRIORITY_LABEL_MAP))

export const STATUS_SHORT: Record<string, string> = {
  'In Progress': 'In Prog',
  Backlog: 'Backlog',
  Analysis: 'Analysis',
  Specs: 'Specs',
  Review: 'Review',
  Done: 'Done',
}

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
