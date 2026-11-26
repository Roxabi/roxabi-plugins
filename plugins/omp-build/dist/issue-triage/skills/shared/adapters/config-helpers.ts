/**
 * Pure config helper functions extracted from the legacy config.ts shim.
 * These are used by EnvConfigAdapter and re-exported from config.ts for backward compat.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { ConfigError } from '../domain/errors'

/**
 * Project contract file, relative to the repo root.
 *
 * This plugin owns its constant so it remains self-contained and individually
 * installable. There is no fallback to the pre-cutover `.claude/` location:
 * the old path is never read.
 */
const DEV_CORE_YML = '.dev/dev-core.yml'

function repoPin(): string | undefined {
  if (process.env.GITHUB_REPO) return process.env.GITHUB_REPO

  try {
    const yaml = readFileSync(DEV_CORE_YML, 'utf-8')
    const match = yaml.match(/^github_repo:\s*['"]?(.+?)['"]?\s*$/m)
    const value = match?.[1]
    if (value && value !== "''") return value
  } catch {
    /* file not found — fall through */
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

export function sameGitHubRepo(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

function commandOutput(args: string[]): string | undefined {
  let bytes: Uint8Array
  try {
    const proc = Bun.spawnSync(args, { stdout: 'pipe', stderr: 'pipe' })
    if (proc.exitCode !== 0) return undefined
    bytes = proc.stdout
  } catch {
    return undefined
  }
  try {
    const output = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    // Remove the command's line terminator, not whitespace in a Git URL.
    return output.endsWith('\n') ? output.slice(0, -1) : output
  } catch {
    // A successful command with invalid bytes is not the same as no origin.
    return ''
  }
}

function probeOutput(command: string, args: string[], env = process.env): string | undefined {
  // Bun honors detached for synchronous children; Node's declarations omit it.
  const options = {
    detached: true,
    encoding: 'utf8' as const,
    env,
    killSignal: 'SIGKILL' as const,
    timeout: 5_000,
  }
  const proc = spawnSync(command, args, options)
  if (proc.error && proc.pid > 0) {
    // spawnSync only kills its direct child on timeout. Clean up its group
    // too, including an SSH Match exec helper that outlived the probe.
    try {
      process.kill(-proc.pid, 'SIGKILL')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  return proc.status === 0 ? proc.stdout.trim() : undefined
}

function ghRepo(): string | undefined {
  const repo = probeOutput('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], {
    ...process.env,
    GH_HOST: 'github.com',
  })
  return repo && REPO_SLUG_RE.test(repo) ? repo : undefined
}

function sshHostname(host: string, user?: string, port?: string): string | undefined {
  // Like gh, consult OpenSSH directly, never Git's potentially checkout-local
  // command configuration. If ssh is unavailable, only literal hosts work.
  const ssh = Bun.which('ssh')
  if (!ssh) return host
  const args = ['-G']
  if (user) args.push('-l', user)
  if (port) args.push('-p', port)
  args.push('--', host)
  return probeOutput(ssh, args)
    ?.match(/^hostname[ \t]+(\S+)$/m)?.[1]
    .toLowerCase()
}

// Match the raw spelling before URL parsing. WHATWG normalization alone could
// turn Git's malformed or foreign origin into a different GitHub URL.
const HTTPS_ORIGIN =
  /^https:\/\/(?:(?:[A-Za-z0-9._~!$&'()*+,;=:-]|%[0-9A-Fa-f]{2})+@)?([A-Za-z0-9.-]+)(?::([0-9]+))?\/((?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2})+\/(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2})+)(\/?)$/
const SSH_ORIGIN =
  /^ssh:\/\/(?:((?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2})+)@)?([A-Za-z0-9._-]+)(?::([0-9]+))?\/((?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2})+\/(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2})+)\/?$/
const SCP_ORIGIN = /^(?:([A-Za-z0-9._-]+)@)?([A-Za-z0-9._-]+):([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*)$/

function decodeUriPart(value: string): string | undefined {
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}

function originRepo(url: string): string | undefined {
  if (/[^\x21-\x7e]/.test(url)) return undefined
  const https = HTTPS_ORIGIN.exec(url)
  const ssh = SSH_ORIGIN.exec(url)
  const scp = https || ssh ? null : SCP_ORIGIN.exec(url)
  if (!https && !ssh && !scp) return undefined

  const host = (https?.[1] ?? ssh?.[2] ?? scp?.[2] ?? '').toLowerCase()
  const rawPath = https?.[3] ?? ssh?.[4] ?? scp?.[3] ?? ''
  const path = scp ? rawPath : decodeUriPart(rawPath)
  const repo = path?.replace(/\.git$/, '')
  if (!repo || !REPO_SLUG_RE.test(repo)) return undefined

  const rawPort = https?.[2] ?? ssh?.[3]
  const port = rawPort === undefined ? undefined : Number(rawPort)
  if (port !== undefined && (port < 1 || port > 65_535)) return undefined

  if (https) {
    const uri = URL.parse(url)
    const expectedPort = port === undefined || port === 443 ? '' : String(port)
    if (uri?.hostname !== host || uri.port !== expectedPort || uri.pathname !== `/${rawPath}${https[4]}`) {
      return undefined
    }
    return host === 'github.com' ? repo : undefined
  }

  const user = ssh?.[1] ? decodeUriPart(ssh[1]) : scp?.[1]
  if (ssh?.[1] && (!user || !/^[A-Za-z0-9._-]+$/.test(user))) return undefined
  const effectiveHost = sshHostname(host, user, port === undefined ? undefined : String(port))
  return effectiveHost === 'github.com' || effectiveHost === 'ssh.github.com' ? repo : undefined
}

export function detectGitHubRepo({ notice = true } = {}): string {
  const pin = repoPin()
  if (pin !== undefined) {
    if (REPO_SLUG_RE.test(pin)) return pin
    throw new ConfigError('Invalid GitHub repo pin. Expected "owner/repo" in GITHUB_REPO or .dev/dev-core.yml.')
  }

  const url = commandOutput(['git', 'remote', 'get-url', 'origin'])
  const remotes = url === undefined || notice ? commandOutput(['git', 'remote'])?.split('\n') : undefined
  if (url !== undefined || remotes?.includes('origin')) {
    const repo = url && originRepo(url)
    if (!repo) {
      throw new ConfigError(
        'Cannot use git remote "origin": expected a github.com owner/repo remote. Set GITHUB_REPO or github_repo explicitly.',
      )
    }
    // Never use gh to choose a target when origin exists. In a multi-remote
    // checkout its independent answer is useful only to explain a disagreement.
    if (notice && remotes && remotes.length > 1) {
      const gh = ghRepo()
      if (gh && !sameGitHubRepo(gh, repo)) {
        console.error(`Using ${repo} from git remote "origin"; preferring origin over gh repo view (${gh}).`)
      }
    }
    return repo
  }

  const fallback = ghRepo()
  if (fallback) return fallback
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

/**
 * Fold case and separators so `P3 - Low`, `P3-low` and `p3_low` share one key.
 * Shared by the alias-table builder and the lookup below on purpose: if the two
 * ever normalise differently, every lookup misses silently.
 */
function normalizePrioritySpelling(input: string): string {
  return input
    .trim()
    .toUpperCase()
    .replace(/[-_\s]+/g, '-')
}

/** Every separator-insensitive spelling of a canonical value or its label → canonical. */
const PRIORITY_SPELLING_ALIASES: Record<string, string> = Object.fromEntries(
  Object.entries(PRIORITY_LABEL_MAP).flatMap(([canonical, label]) => [
    [normalizePrioritySpelling(canonical), canonical],
    [normalizePrioritySpelling(label), canonical],
  ]),
)

/**
 * Accepted `--priority` spelling families, for CLI error messages. Each family
 * is derived from the table that decides it, so an alias cannot be advertised
 * without being accepted. The reverse does not hold: separator and case
 * variants of the listed spellings resolve too and are not enumerated here.
 */
export const PRIORITY_INPUT_HINT = `${DEFAULT_PRIORITY_OPTIONS.join(', ')} (aliases: ${Object.keys(PRIORITY_ALIASES).join('/')}, ${Object.values(PRIORITY_LABEL_MAP).join('/')})`

/** Resolve loose user input to a canonical status key, or undefined. */
export function resolveStatus(input: string): string | undefined {
  const value = input.trim()
  if (CANONICAL_STATUSES.has(value)) return value
  return STATUS_ALIASES[value.toUpperCase()]
}

/**
 * Resolve loose user input to a canonical priority key, or undefined.
 *
 * Accepts, in order: the canonical value (`P3 - Low`), the short/word aliases
 * (`P3`, `LOW`), then any separator/case variant of either the canonical value
 * or the GitHub *label* spelling (`P3-low`, `p3_low`, `P3 Low`). The label is
 * what `gh issue view` and `gh label list` display, so it is the string a
 * caller is most likely to type — it used to be the one string rejected (#525).
 */
export function resolvePriority(input: string): string | undefined {
  // Trimmed once here rather than inside one branch: whether padding is
  // tolerated must not depend on which spelling the caller happened to type.
  const value = input.trim()
  if (CANONICAL_PRIORITIES.has(value)) return value
  return PRIORITY_ALIASES[value.toUpperCase()] ?? PRIORITY_SPELLING_ALIASES[normalizePrioritySpelling(value)]
}

/** Resolve loose user input to a canonical size key, or undefined. */
export function resolveSize(input: string): string | undefined {
  const value = input.trim()
  const upper = value.toUpperCase().replace(/[-\s]/g, '-')
  // Tier-based schema (S / F-lite / F-full).
  if (CANONICAL_SIZES.has(value)) return value
  if (CANONICAL_SIZES.has(upper)) return upper
  // Legacy → new schema aliasing.
  if (upper === 'XS') return 'S'
  if (upper === 'M') return 'F-lite'
  if (upper === 'L' || upper === 'XL') return 'F-full'
  // F-lite variations
  if (upper === 'FLITE' || upper === 'F_LITE' || upper === 'F-LITE') return 'F-lite'
  // F-full variations
  if (upper === 'FFULL' || upper === 'F_FULL' || upper === 'F-FULL') return 'F-full'
  return
}

/**
 * Resolve loose user input to a canonical lane key, or undefined.
 *
 * Lane keys are lower-case by definition, so `A1` and ` a1 ` fold to `a1`
 * rather than being rejected: the flag is fatal on an unrecognised value, so
 * intolerance here turns a typo into a half-applied command.
 */
export function resolveLane(input: string): string | undefined {
  if (CANONICAL_LANES.has(input)) return input
  const folded = input.trim().toLowerCase()
  return CANONICAL_LANES.has(folded) ? folded : undefined
}

// --- Exports consolidated from legacy config.ts shim ---

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
