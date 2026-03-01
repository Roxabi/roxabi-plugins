/**
 * Shared configuration constants for GitHub Project V2 integration.
 * Single source of truth — used by both issues/ and issue-triage/ skills.
 *
 * GITHUB_REPO is auto-detected from git remote "origin" when not set via env.
 * PROJECT_ID and field IDs default to empty string — callers handle absence.
 * Run `/init` to auto-detect and write all values to `.env`.
 */

export function detectGitHubRepo(): string {
  if (process.env.GITHUB_REPO) return process.env.GITHUB_REPO
  try {
    const proc = Bun.spawnSync(['git', 'remote', 'get-url', 'origin'], { stdout: 'pipe', stderr: 'pipe' })
    const url = new TextDecoder().decode(proc.stdout).trim()
    // SSH: git@github.com:owner/repo.git  |  HTTPS: https://github.com/owner/repo.git
    const match = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/)
    if (match?.[1]) return match[1]
  } catch {}
  throw new Error('Cannot detect GitHub repo. Set GITHUB_REPO env var or ensure git remote "origin" is configured.')
}

export const GITHUB_REPO = detectGitHubRepo()
export const PROJECT_ID = process.env.PROJECT_ID ?? ''
export const STATUS_FIELD_ID = process.env.STATUS_FIELD_ID ?? ''
export const SIZE_FIELD_ID = process.env.SIZE_FIELD_ID ?? ''
export const PRIORITY_FIELD_ID = process.env.PRIORITY_FIELD_ID ?? ''

/** Parse a JSON env var into a Record, falling back to the provided default. */
function parseOptionsEnv(envVar: string, fallback: Record<string, string>): Record<string, string> {
  const raw = process.env[envVar]
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as Record<string, string>
  } catch {
    return fallback
  }
}

// Canonical option maps: display name → GitHub option ID
// Configure via STATUS_OPTIONS_JSON, SIZE_OPTIONS_JSON, PRIORITY_OPTIONS_JSON env vars.
// Run `/init` to auto-detect and populate these from your GitHub Project V2 board.
export const STATUS_OPTIONS: Record<string, string> = parseOptionsEnv('STATUS_OPTIONS_JSON', {})

export const SIZE_OPTIONS: Record<string, string> = parseOptionsEnv('SIZE_OPTIONS_JSON', {})

export const PRIORITY_OPTIONS: Record<string, string> = parseOptionsEnv('PRIORITY_OPTIONS_JSON', {})

/** True when PROJECT_ID and at least one option map are configured via env. */
export function isProjectConfigured(): boolean {
  return PROJECT_ID !== '' && Object.keys(STATUS_OPTIONS).length > 0
}

export const NOT_CONFIGURED_MSG =
  'GitHub Project V2 is not configured. Run `/init` to auto-detect project board settings.'

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

export const STANDARD_WORKFLOWS = ['ci.yml', 'deploy-preview.yml'] as const
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
  XS: 1,
  S: 2,
  M: 3,
  L: 4,
  XL: 5,
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

// Canonical names — used for validation regardless of whether option maps are populated
const CANONICAL_STATUSES = new Set(['Backlog', 'Analysis', 'Specs', 'In Progress', 'Review', 'Done'])
const CANONICAL_SIZES = new Set(['XS', 'S', 'M', 'L', 'XL'])
const CANONICAL_PRIORITIES = new Set(['P0 - Urgent', 'P1 - High', 'P2 - Medium', 'P3 - Low'])

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
