/**
 * Pure config helper functions extracted from the legacy config.ts shim.
 * These are used by EnvConfigAdapter and re-exported from config.ts for backward compat.
 */

import { readFileSync } from 'node:fs'
import { ConfigError } from '../domain/errors'

/**
 * Load a config value from .claude/dev-core.yml with 3-tier fallback:
 *   1st: .claude/dev-core.yml (YAML key lookup)
 *   2nd: process.env[envKey]
 *   3rd: gh CLI auto-detect (github_repo)
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

  // 3rd: Auto-detect via gh CLI for supported keys
  if (key === 'github_repo') {
    try {
      const proc = Bun.spawnSync(['gh', 'repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      if (proc.exitCode === 0) return new TextDecoder().decode(proc.stdout).trim()
    } catch {
      /* gh not available */
    }
  }

  return undefined
}

/**
 * A GitHub repo slug: exactly `owner/repo`.
 * Owner: alphanumeric + hyphen, must start with an alphanumeric character
 * (GitHub username rule — dots/underscores not allowed in owner segment).
 * Name: allows dots/underscores after a leading alphanumeric character.
 * Callers do `detectGitHubRepo().split('/')` and expect exactly two non-empty segments.
 */
export const REPO_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * Validate a candidate GitHub repo slug and throw a clear error if it doesn't match.
 * Used by both the yaml/env path and the git-remote fallback in detectGitHubRepo().
 */
function assertValidRepoSlug(value: string): string {
  if (!REPO_SLUG_RE.test(value)) {
    throw new ConfigError(
      `Invalid GitHub repo "${value}". Expected "owner/repo" format ` +
        '(set github_repo in dev-core config or the GITHUB_REPO env var).',
    )
  }
  return value
}

export function detectGitHubRepo(): string {
  const fromYamlOrEnv = loadDevCoreConfig('github_repo', 'GITHUB_REPO')
  if (fromYamlOrEnv) {
    // Guard the yaml/env path: callers do `detectGitHubRepo().split('/')` and
    // expect `owner/repo`. A bare value (e.g. `GITHUB_REPO=myrepo`) would slip
    // through as a silent `undefined` repo → malformed GraphQL. Fail loud here.
    return assertValidRepoSlug(fromYamlOrEnv)
  }
  try {
    const proc = Bun.spawnSync(['git', 'remote', 'get-url', 'origin'], { stdout: 'pipe', stderr: 'pipe' })
    const url = new TextDecoder().decode(proc.stdout).trim()
    // SSH: git@github.com:owner/repo.git  |  HTTPS: https://github.com/owner/repo.git
    const match = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/)
    // Validate the extracted candidate — a malformed remote must not silently
    // return a bad slug that callers would split('/') into garbage GraphQL args.
    if (match?.[1]) return assertValidRepoSlug(match[1])
  } catch {}
  throw new ConfigError(
    'Cannot detect GitHub repo. Set GITHUB_REPO env var or ensure git remote "origin" is configured.',
  )
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
// Tier-based sizes: S (simple), F-lite (subagents), F-full (agent team)
export const DEFAULT_SIZE_OPTIONS = ['S', 'F-lite', 'F-full']
export const PRIORITY_VALUES = ['P0 - Urgent', 'P1 - High', 'P2 - Medium', 'P3 - Low'] as const
export const DEFAULT_PRIORITY_OPTIONS: string[] = [...PRIORITY_VALUES]
export const DEFAULT_LANE_OPTIONS = [
  'a1',
  'a2',
  'a3',
  'b',
  'c1',
  'c2',
  'c3',
  'd',
  'e',
  'f',
  'g',
  'h',
  'i',
  'j',
  'k',
  'l',
  'm',
  'n',
  'o',
  'standalone',
]

const CANONICAL_STATUSES = new Set(DEFAULT_STATUS_OPTIONS)
const CANONICAL_SIZES = new Set(DEFAULT_SIZE_OPTIONS)
const CANONICAL_PRIORITIES = new Set(DEFAULT_PRIORITY_OPTIONS)
export const CANONICAL_LANES = new Set(DEFAULT_LANE_OPTIONS)

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
  const upper = input.toUpperCase().replace(/[-\s]/g, '-')
  // Tier-based schema (S / F-lite / F-full).
  if (CANONICAL_SIZES.has(input)) return input
  if (CANONICAL_SIZES.has(upper)) return upper
  // Legacy → new schema aliasing
  if (upper === 'XS') return 'S'
  if (upper === 'M') return 'F-lite'
  if (upper === 'L' || upper === 'XL') return 'F-full'
  // F-lite variations
  if (upper === 'FLITE' || upper === 'F_LITE' || upper === 'F-LITE') return 'F-lite'
  // F-full variations
  if (upper === 'FFULL' || upper === 'F_FULL' || upper === 'F-FULL') return 'F-full'
  return
}

/** Resolve loose user input to a canonical lane key, or undefined. */
export function resolveLane(input: string): string | undefined {
  if (CANONICAL_LANES.has(input)) return input
  return
}

// --- Exports consolidated from legacy config.ts shim ---

export const GITHUB_REPO = detectGitHubRepo()

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

/** Map canonical size → GitHub label name. */
export const SIZE_LABEL_MAP: Record<string, string> = {
  S: 'size:S',
  'F-lite': 'size:F-lite',
  'F-full': 'size:F-full',
}

/** Set of all size label names (for stale label removal). */
export const SIZE_LABELS_SET = new Set(Object.values(SIZE_LABEL_MAP))

/** Map canonical lane → GitHub label name. */
export const LANE_LABEL_MAP: Record<string, string> = Object.fromEntries(
  DEFAULT_LANE_OPTIONS.map((lane) => [lane, `graph:lane/${lane}`]),
)

/** Set of all lane label names (for stale label removal). */
export const LANE_LABELS_SET = new Set(Object.values(LANE_LABEL_MAP))

/** Map canonical status → GitHub label name. */
export const STATUS_LABEL_MAP: Record<string, string> = {
  Backlog: 'status:Backlog',
  Analysis: 'status:Analysis',
  Specs: 'status:Specs',
  'In Progress': 'status:In Progress',
  Review: 'status:Review',
  Done: 'status:Done',
}

/** Set of all status label names (for stale label removal). */
export const STATUS_LABELS_SET = new Set(Object.values(STATUS_LABEL_MAP))

export const STATUS_SHORT: Record<string, string> = {
  'In Progress': 'In Prog',
  Backlog: 'Backlog',
  Analysis: 'Analysis',
  Specs: 'Specs',
  Review: 'Review',
  Done: 'Done',
}

export const PRIORITY_ORDER: Record<string, number> = {
  'P0 - Urgent': 0,
  'P1 - High': 1,
  'P2 - Medium': 2,
  'P3 - Low': 3,
  '-': 99,
}

export const SIZE_ORDER: Record<string, number> = {
  'F-full': 0,
  'F-lite': 1,
  S: 2,
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
