/**
 * hotfix-density.ts — hotfix-density pre-flight gauge for /promote
 *
 * Measures the ratio of hotfix-class commits in staging since the last
 * promotion anchor and emits an advisory signal (never a hard gate).
 *
 * A commit is hotfix-class if:
 *   • its title matches /^fix:/i  (Conventional Commit), OR
 *   • its merged PR carries the `hotfix` label (batched API query)
 *
 * Designed for pure-logic testability: all I/O is injected via Deps interface.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type Gauge = 'green' | 'warn' | 'pause'

export interface HotfixDensityResult {
  /** Total commits in the window */
  total: number
  /** Commits classified as hotfix-class */
  hotfixCount: number
  /** hotfixCount / total (0 if total === 0) */
  density: number
  /** Advisory signal */
  gauge: Gauge
  /** ISO date string of the window anchor (tag date, promotion merge date, or 30d fallback) */
  anchorDate: string
  /** How the anchor was determined */
  anchorSource: 'tag' | 'promotion-merge' | 'fallback-30d'
  /** Present when anchorSource === 'fallback-30d' */
  anchorWarn?: string
}

// ─── Dependencies (injected for testability) ──────────────────────────────────

export interface Deps {
  /** Run a shell command, return trimmed stdout. Throws on non-zero exit. */
  run: (cmd: string[], cwd?: string) => Promise<string>
}

// ─── Thresholds (SSoT — referenced by SKILL.md) ───────────────────────────────

/** Density below this → green */
export const THRESHOLD_GREEN = 0.2
/** Density below this (and >= THRESHOLD_GREEN) → warn */
export const THRESHOLD_WARN = 0.4
/** Density at or above THRESHOLD_WARN → recommend pause */
export const THRESHOLD_PAUSE = THRESHOLD_WARN

// ─── Gauge classification ─────────────────────────────────────────────────────

/**
 * Classify a density ratio into a gauge level.
 *
 * < THRESHOLD_GREEN  → green
 * < THRESHOLD_WARN   → warn
 * >= THRESHOLD_WARN  → pause
 */
export function classifyDensity(density: number): Gauge {
  if (density < THRESHOLD_GREEN) return 'green'
  if (density < THRESHOLD_WARN) return 'warn'
  return 'pause'
}

// ─── Window anchor resolution ─────────────────────────────────────────────────

/**
 * Determine the window anchor date for counting commits.
 *
 * Priority:
 *   1. Last `<component>/vX.Y.Z` tag in the repo
 *   2. Last promotion merge-commit (merge commit whose title matches
 *      "chore: promote staging to main")
 *   3. 30-calendar-day fallback (emits anchorWarn)
 *
 * Returns anchorDate (ISO string) and anchorSource.
 */
export async function resolveAnchor(
  cwd: string | undefined,
  deps: Pick<Deps, 'run'>,
): Promise<{ anchorDate: string; anchorSource: HotfixDensityResult['anchorSource']; anchorWarn?: string }> {
  // 1. Last <component>/vX.Y.Z tag
  try {
    const tagOut = await deps.run(
      ['git', 'tag', '--list', '--sort=-creatordate', '--format=%(refname:short) %(creatordate:iso-strict)'],
      cwd,
    )
    if (tagOut) {
      for (const line of tagOut.split('\n').filter(Boolean)) {
        const [tagName, ...dateParts] = line.trim().split(' ')
        // Match <component>/vX.Y.Z or vX.Y.Z
        if (/^(?:.+\/)?v\d+\.\d+\.\d+/.test(tagName)) {
          const anchorDate = dateParts.join(' ')
          if (anchorDate) {
            return { anchorDate, anchorSource: 'tag' }
          }
        }
      }
    }
  } catch {
    // fall through
  }

  // 2. Last promotion merge-commit
  try {
    const logOut = await deps.run(
      [
        'git',
        'log',
        'main',
        '--merges',
        '--oneline',
        '--format=%H %ai',
        '--grep=chore: promote staging to main',
        '-1',
      ],
      cwd,
    )
    if (logOut) {
      const parts = logOut.trim().split(' ')
      // Format: <sha> <date> <time> <tz>
      if (parts.length >= 3) {
        const anchorDate = parts.slice(1).join(' ')
        return { anchorDate, anchorSource: 'promotion-merge' }
      }
    }
  } catch {
    // fall through
  }

  // 3. 30-day fallback
  const fallbackDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  return {
    anchorDate: fallbackDate,
    anchorSource: 'fallback-30d',
    anchorWarn: 'No release tag or promotion merge found — using 30-day window (may be inaccurate)',
  }
}

// ─── Commit listing ───────────────────────────────────────────────────────────

/**
 * List all commits on staging since anchorDate (exclusive).
 * Returns an array of { sha, title } objects.
 */
export async function listCommitsSince(
  anchorDate: string,
  cwd: string | undefined,
  deps: Pick<Deps, 'run'>,
): Promise<Array<{ sha: string; title: string }>> {
  let out: string
  try {
    out = await deps.run(
      ['git', 'log', 'main..staging', `--after=${anchorDate}`, '--format=%H\t%s'],
      cwd,
    )
  } catch {
    return []
  }

  if (!out.trim()) return []

  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t')
      if (tab === -1) return { sha: line.trim(), title: '' }
      return { sha: line.slice(0, tab).trim(), title: line.slice(tab + 1).trim() }
    })
}

// ─── Hotfix label query ───────────────────────────────────────────────────────

/**
 * Fetch SHAs of merged PRs with the `hotfix` label since anchorDate.
 * Uses a single batched gh query (no per-commit API calls).
 *
 * Returns a Set of commit SHAs (merge commits on main) for matching PRs.
 */
export async function fetchHotfixPrShas(
  anchorDate: string,
  deps: Pick<Deps, 'run'>,
): Promise<Set<string>> {
  let out: string
  try {
    out = await deps.run([
      'gh',
      'pr',
      'list',
      '--state',
      'merged',
      '--search',
      `label:hotfix merged:>=${anchorDate.slice(0, 10)}`,
      '--json',
      'mergeCommit',
      '--jq',
      '.[].mergeCommit.oid',
    ])
  } catch {
    // gh may fail (no auth, network, etc.) — degrade gracefully
    return new Set()
  }

  const shas = new Set<string>()
  for (const line of out.split('\n').filter(Boolean)) {
    shas.add(line.trim())
  }
  return shas
}

// ─── Hotfix classification ────────────────────────────────────────────────────

/**
 * Classify a commit as hotfix-class.
 *
 * Union rule: hotfix if title matches /^fix:/i OR sha in hotfixPrShas.
 */
export function isHotfix(sha: string, title: string, hotfixPrShas: Set<string>): boolean {
  return /^fix:/i.test(title) || hotfixPrShas.has(sha)
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Compute the hotfix-density pre-flight result.
 *
 * @param cwd  Optional working directory (defaults to process.cwd())
 */
export async function computeHotfixDensity(
  cwd: string | undefined,
  deps: Deps,
): Promise<HotfixDensityResult> {
  const { anchorDate, anchorSource, anchorWarn } = await resolveAnchor(cwd, deps)

  const commits = await listCommitsSince(anchorDate, cwd, deps)
  const total = commits.length

  if (total === 0) {
    return {
      total: 0,
      hotfixCount: 0,
      density: 0,
      gauge: 'green',
      anchorDate,
      anchorSource,
      ...(anchorWarn ? { anchorWarn } : {}),
    }
  }

  const hotfixPrShas = await fetchHotfixPrShas(anchorDate, deps)

  let hotfixCount = 0
  for (const { sha, title } of commits) {
    if (isHotfix(sha, title, hotfixPrShas)) hotfixCount++
  }

  const density = hotfixCount / total
  const gauge = classifyDensity(density)

  return {
    total,
    hotfixCount,
    density,
    gauge,
    anchorDate,
    anchorSource,
    ...(anchorWarn ? { anchorWarn } : {}),
  }
}

// ─── Output formatting ────────────────────────────────────────────────────────

/**
 * Format a HotfixDensityResult as a human-readable pre-flight report line.
 *
 * Example outputs:
 *   hotfix-density: 2/10 (20%) — WARN: elevated hotfix rate; consider /checkup
 *   hotfix-density: 1/10 (10%) — OK
 *   hotfix-density: 5/10 (50%) — PAUSE recommended: >40% hotfix rate; run /checkup
 */
export function formatResult(result: HotfixDensityResult): string {
  const pct = (result.density * 100).toFixed(0)
  const ratio = `${result.hotfixCount}/${result.total}`

  let signal: string
  switch (result.gauge) {
    case 'green':
      signal = 'OK'
      break
    case 'warn':
      signal = 'WARN: elevated hotfix rate; consider /checkup'
      break
    case 'pause':
      signal = 'PAUSE recommended: >40% hotfix rate; run /checkup'
      break
  }

  let line = `hotfix-density: ${ratio} (${pct}%) — ${signal}`

  if (result.anchorWarn) {
    line += `\n  note: ${result.anchorWarn}`
  }

  return line
}
