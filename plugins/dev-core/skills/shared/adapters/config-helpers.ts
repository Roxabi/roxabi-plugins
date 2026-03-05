/**
 * Pure config helper functions extracted from the legacy config.ts shim.
 * These are used by EnvConfigAdapter and re-exported from config.ts for backward compat.
 */
import type { ProjectFieldIds } from '../domain/types'
import type { WorkspaceProject } from '../ports/workspace'

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

export const GH_PROJECT_ID = process.env.GH_PROJECT_ID ?? ''
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

export const STATUS_OPTIONS: Record<string, string> = parseOptionsEnv('STATUS_OPTIONS_JSON', {})
export const SIZE_OPTIONS: Record<string, string> = parseOptionsEnv('SIZE_OPTIONS_JSON', {})
export const PRIORITY_OPTIONS: Record<string, string> = parseOptionsEnv('PRIORITY_OPTIONS_JSON', {})

/** True when GH_PROJECT_ID and at least one option map are configured via env. */
export function isProjectConfigured(): boolean {
  return (process.env.GH_PROJECT_ID ?? '') !== '' && Object.keys(STATUS_OPTIONS).length > 0
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
