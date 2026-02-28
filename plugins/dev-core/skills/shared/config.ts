/**
 * Shared configuration constants for GitHub Project V2 integration.
 * Single source of truth — used by both issues/ and issue-triage/ skills.
 *
 * All values are configurable via env vars. Run `/init` to auto-detect and
 * write them to `.env`. Hardcoded fallbacks are for roxabi_boilerplate only
 * and will be removed in a future version.
 */

export const PROJECT_ID = process.env.PROJECT_ID ?? 'PVT_kwHODEqYK84BOId3'
export const GITHUB_REPO = process.env.GITHUB_REPO ?? 'Roxabi/roxabi_boilerplate'
export const STATUS_FIELD_ID = process.env.STATUS_FIELD_ID ?? 'PVTSSF_lAHODEqYK84BOId3zg87HNM'
export const SIZE_FIELD_ID = process.env.SIZE_FIELD_ID ?? 'PVTSSF_lAHODEqYK84BOId3zg87HYo'
export const PRIORITY_FIELD_ID = process.env.PRIORITY_FIELD_ID ?? 'PVTSSF_lAHODEqYK84BOId3zg87HYs'

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
// Override via STATUS_OPTIONS_JSON, SIZE_OPTIONS_JSON, PRIORITY_OPTIONS_JSON env vars
export const STATUS_OPTIONS: Record<string, string> = parseOptionsEnv('STATUS_OPTIONS_JSON', {
  Backlog: 'df6ee93b',
  Analysis: 'bec91bb0',
  Specs: 'ad9a9195',
  'In Progress': '331d27a4',
  Review: 'ee30a001',
  Done: 'bfdc35bd',
})

export const SIZE_OPTIONS: Record<string, string> = parseOptionsEnv('SIZE_OPTIONS_JSON', {
  XS: 'dfcde6df',
  S: '4390f522',
  M: 'e2c52fb1',
  L: 'f8ea3803',
  XL: '228a917d',
})

export const PRIORITY_OPTIONS: Record<string, string> = parseOptionsEnv('PRIORITY_OPTIONS_JSON', {
  'P0 - Urgent': 'ed739db3',
  'P1 - High': '742ac87b',
  'P2 - Medium': '723e7784',
  'P3 - Low': '796f973f',
})

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

/** Resolve loose user input to a canonical status key, or undefined. */
export function resolveStatus(input: string): string | undefined {
  if (STATUS_OPTIONS[input]) return input
  return STATUS_ALIASES[input.toUpperCase()]
}

/** Resolve loose user input to a canonical priority key, or undefined. */
export function resolvePriority(input: string): string | undefined {
  if (PRIORITY_OPTIONS[input]) return input
  return PRIORITY_ALIASES[input.toUpperCase()]
}

/** Resolve loose user input to a canonical size key, or undefined. */
export function resolveSize(input: string): string | undefined {
  const upper = input.toUpperCase()
  if (SIZE_OPTIONS[upper]) return upper
  return
}
