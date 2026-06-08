// Must mock node:fs to block .claude/dev-core.yml before config-helpers loads.
// detectGitHubRepo() runs eagerly at import — GITHUB_REPO must be set first.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    readFileSync: (path: string, encoding?: BufferEncoding) => {
      if (path === '.claude/dev-core.yml') throw new Error('ENOENT')
      return actual.readFileSync(path, encoding ?? 'utf-8')
    },
  }
})

import { describe, expect, it, vi } from 'vitest'

process.env.GITHUB_REPO = 'Test/test-repo'

const { PRIORITY_ALIASES, PRIORITY_SHORT, PRIORITY_VALUES: PV_FROM_CONFIG } = await import('../adapters/config-helpers')

const { LEGACY_LABEL_MAP } = await import('../../issue-triage/lib/migrate-backfill')

// ─── PRIORITY_ALIASES ─────────────────────────────────────────────────────────

describe('PRIORITY_ALIASES', () => {
  it('P0 maps to "P0 - Urgent"', () => {
    expect(PRIORITY_ALIASES.P0).toBe('P0 - Urgent')
  })

  it('P1 maps to "P1 - High"', () => {
    expect(PRIORITY_ALIASES.P1).toBe('P1 - High')
  })

  it('P2 maps to "P2 - Medium"', () => {
    expect(PRIORITY_ALIASES.P2).toBe('P2 - Medium')
  })

  it('P3 maps to "P3 - Low"', () => {
    expect(PRIORITY_ALIASES.P3).toBe('P3 - Low')
  })

  it('also covers verbose forms: URGENT/HIGH/MEDIUM/LOW', () => {
    expect(PRIORITY_ALIASES.URGENT).toBe('P0 - Urgent')
    expect(PRIORITY_ALIASES.HIGH).toBe('P1 - High')
    expect(PRIORITY_ALIASES.MEDIUM).toBe('P2 - Medium')
    expect(PRIORITY_ALIASES.LOW).toBe('P3 - Low')
  })
})

// ─── PRIORITY_SHORT ───────────────────────────────────────────────────────────

describe('PRIORITY_SHORT', () => {
  it('"P0 - Urgent" maps to "P0"', () => {
    expect(PRIORITY_SHORT['P0 - Urgent']).toBe('P0')
  })

  it('"P1 - High" maps to "P1"', () => {
    expect(PRIORITY_SHORT['P1 - High']).toBe('P1')
  })

  it('"P2 - Medium" maps to "P2"', () => {
    expect(PRIORITY_SHORT['P2 - Medium']).toBe('P2')
  })

  it('"P3 - Low" maps to "P3"', () => {
    expect(PRIORITY_SHORT['P3 - Low']).toBe('P3')
  })

  it('PRIORITY_ALIASES and PRIORITY_SHORT are inverses for all 4 P-keys', () => {
    // Arrange
    const pKeys = ['P0', 'P1', 'P2', 'P3'] as const
    // Act / Assert
    for (const p of pKeys) {
      const canonical = PRIORITY_ALIASES[p]
      expect(PRIORITY_SHORT[canonical]).toBe(p)
    }
  })
})

// ─── PRIORITY_VALUES (4-tuple + dual re-export) ───────────────────────────────

describe('PRIORITY_VALUES', () => {
  it('is the 4-element tuple in order', () => {
    expect(PV_FROM_CONFIG).toEqual(['P0 - Urgent', 'P1 - High', 'P2 - Medium', 'P3 - Low'])
  })

  it('has exactly 4 elements', () => {
    expect(PV_FROM_CONFIG).toHaveLength(4)
  })

  it('every element is a key in PRIORITY_SHORT', () => {
    // Fails if PRIORITY_VALUES diverges from PRIORITY_SHORT keys
    for (const v of PV_FROM_CONFIG) {
      expect(PRIORITY_SHORT).toHaveProperty(v)
    }
  })
})

// ─── migrate.ts LEGACY_LABEL_MAP.priority (label path) ───────────────────────

describe('migrate LEGACY_LABEL_MAP.priority', () => {
  it('is the same object reference as PRIORITY_ALIASES', () => {
    // Locks: migrate.ts delegates to the canonical map, not an inline copy
    expect(LEGACY_LABEL_MAP.priority).toBe(PRIORITY_ALIASES)
  })

  it('P0-style token resolves via LEGACY_LABEL_MAP.priority', () => {
    // Arrange — legacy priority token extracted from label "P0-critical"
    const legacyToken = 'P0'
    // Act
    const canonical = LEGACY_LABEL_MAP.priority[legacyToken]
    // Assert
    expect(canonical).toBe('P0 - Urgent')
  })

  it('P3-style token resolves to P3 - Low', () => {
    expect(LEGACY_LABEL_MAP.priority.P3).toBe('P3 - Low')
  })
})
